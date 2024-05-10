const createError = require('http-errors');
const express = require('express');
const fs = require('fs');
let path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
// Refactored packages
const flash = require('express-flash');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const bcrypt = require('bcrypt');
const MD5 = require('crypto-js/md5');
const { pool, init_DB, query, execute, get_user_id} = require('./utils/db');



// Prometheus tracking
const { prometheus, prometheusMiddleware } = require('./utils/prometheus');

// Configuration
const PER_PAGE = 30;
const SECRET_KEY = 'development key';

let app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Session
app.use(session({
  secret: SECRET_KEY,
  resave: false,
  saveUninitialized: true
}));

// Setup
app.use(expressLayouts);
app.set('layout', 'layout.ejs');
app.use(logger('dev'));
app.use(flash());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Apply middleware to track HTTP requests
app.use(prometheusMiddleware);

app.locals.user = null; // just forces layout.ejs to render. Should be refactored properly.


const format_datetime = (timestamp) => {
  return new Date(timestamp * 1000).toISOString().replace(/T/, ' ').replace(/\..+/, '');
};

const gravatarUrl = (email, size = 80) => {
  const hash = MD5(email.trim().toLowerCase()).toString();
  return `http://www.gravatar.com/avatar/${hash}?d=identicon&s=${size}`;
}

// Add datetimeformat function to locals object, so it can be called in .ejs views
app.locals.format_datetime = format_datetime;
app.locals.gravatarUrl = gravatarUrl;




// Routes
app.get('/', async (req, res) => {
  // Implement your logic here
  try {
    console.log("We got a visitor from: ", req.socket.remoteAddress);

    // Implement your logic here
    let user = null;
    if (req.session?.user) {
      user = await query('SELECT * FROM account WHERE user_id = $1', [req.session.user.user_id]);
    }

    if (!user) {
      return res.redirect('/public');
    }

    const messages = await query(`
        SELECT message.*, account.* FROM message
        INNER JOIN account ON message.author_id = account.user_id
        WHERE message.flagged = 0 AND (
            account.user_id = $1 OR
            account.user_id IN (SELECT whom_id FROM follower WHERE who_id = $2)
        )
        ORDER BY message.pub_date DESC
        LIMIT $3
    `, [req.session.user.user_id, req.session.user.user_id, PER_PAGE]);

    res.render('timeline.ejs', { user: req.session.user, messages, title: "My Timeline", flashes: req.flash('success'), endpoint: "user_timline" });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Prometheus tracking endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  const metrics = await prometheus.register.metrics();
  res.end(metrics);
});

app.get('/public', async (req, res) => {
  // Implement your logic here
  try {
    // Implement your logic here
    const messages = await query(`
        SELECT message.*, account.* FROM message
        INNER JOIN account ON message.author_id = account.user_id
        WHERE message.flagged = 0
        ORDER BY message.pub_date DESC
        LIMIT $1
    `, [PER_PAGE]);

    res.render('timeline.ejs', { user: req.session.user, messages, title: "Public Timeline", flashes: req.flash('success'), endpoint: '' });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get('/register', async (req, res) => {
  if (req.session.user) {
    return res.redirect('/timeline');
  }
  res.render('register.ejs', { error: null, flashes: req.flash('success') });
});

app.post('/register', async (req, res) => {
  try {
    const { username, email, password, password2 } = req.body;

    if (!username || !email || !password || !password2) {
      return res.render('register.ejs', { error: 'All fields are required', flashes: req.flash('success') });
    }

    if (password !== password2) {
      return res.render('register.ejs', { error: 'The two passwords do not match', flashes: req.flash('success') });
    }

    // Check if email is valid
    if (!email.includes('@')) {
      return res.render('register.ejs', { error: 'You have to enter a valid email address', flashes: req.flash('success') });
    }

    // Check if username is already taken
    const existingUser = await get_user_id(username);
    if (existingUser) {
      return res.render('register.ejs', { error: 'The username is already taken', flashes: req.flash('success') });
    }

    // Insert user into the database
    const hashedPassword = bcrypt.hashSync(password, 10);
    await execute('INSERT INTO account (username, email, pw_hash) VALUES ($1, $2, $3)',
      [username, email, hashedPassword]);

    req.flash('success', 'You were successfully registered and can login now');
    res.redirect('/login');
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/timeline');
  }
  res.render('login.ejs', { user: req.session.user, error: null, flashes: req.flash('success') });
});

app.post('/login', async (req, res) => {
  // Implement your logic here
  try {
    const { username, password } = req.body;

    // Query the user from the database
    const user = await query('SELECT * FROM account WHERE username = $1', [username], true);

    if (!user || user.length === 0) {
      return res.render('login.ejs', { error: 'Invalid username', flashes: req.flash('success') });
    }

    // Check if password matches
    const passwordMatch = bcrypt.compareSync(password, user.pw_hash);

    if (!passwordMatch) {
      return res.render('login.ejs', { error: 'Invalid password', flashes: req.flash('success') });
    }

    // Set user session
    req.session.user = user;
    req.session.save();

    req.flash('success', 'You were logged in');
    res.redirect('/');
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get('/logout', async (req, res) => {
  req.flash('success', 'You were logged out');
  delete req.session.user;
  res.redirect('/public');
});

app.post('/add_message', async (req, res) => {
  // Check if user is authenticated
  if (!req.session.user) {
    res.status(401).send('Unauthorized');
    return;
  }

  const text = req.body.text;

  if (!text) {
    res.status(400).send('Bad Request');
    return;
  }
  try {
    // Insert message into the database
    await execute(
      'INSERT INTO message (author_id, text, pub_date, flagged) VALUES ($1, $2, $3, 0)',
      [req.session.user.user_id, text, Math.floor(Date.now() / 1000)]
    );

    req.flash('success', 'Your message was recorded');
    res.redirect('/');
  } catch (error) {
    console.error('Error inserting message:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/:username', async (req, res) => {
  try {
    // Retrieve the profile user from the database
    let profile_user = await query("SELECT * FROM account where username = $1", [req.params.username], true);
    

    // If profile_user is not found, return 404
    if (!profile_user) {
      res.status(404).send('User not found');
      return;
    }
    let followed = false;

    // Check if the logged-in user follows the profile user
    if (req.session.user) {
      const follower = await query(
        'SELECT 1 FROM follower WHERE who_id = $1 AND whom_id = $2',
        [req.session.user.user_id, profile_user.user_id]
      );

      followed = follower.length > 0;
    }

    // Fetch messages for the profile user
    const messages = await query(
      `SELECT message.*, account.* FROM message JOIN account 
       ON account.user_id = message.author_id 
       WHERE account.user_id = $1 
       ORDER BY message.pub_date DESC 
       LIMIT $2`,
      [profile_user.user_id, PER_PAGE]
    );

    // Render the timeline template with messages and other data
    res.render('timeline.ejs', {
      messages: messages,
      followed: followed,
      user: req.session.user,
      profile_user: profile_user,
      title: profile_user.username + "'s Timeline",
      flashes: req.flash('success'),
      endpoint: 'user_timeline'
    });
  } catch (error) {
    console.error('Error fetching user timeline:', error);
    res.status(500).send('Internal Server Error');
  }
});


app.get('/:username/follow', async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session.user) {
      return res.status(401).send('Unauthorized');
    }

    // Get whom_id from the database
    const username = req.params.username;

    // Sanitize input to prevent SQL injection
    const sanitizedUsername = sanitizeInput(username);

    const whom_id = await get_user_id(sanitizedUsername);
    if (!whom_id) {
      return res.status(404).send('User not found');
    }

    // Insert into follower table using parameterized queries to prevent SQL injection
    await execute('insert into follower (who_id, whom_id) values ($1, $2)', [req.session.user.user_id, whom_id]);
    req.flash('success', `You are now following "${username}"`);
    
    // Redirect to the sanitized URL to prevent XSS attacks
    const sanitizedUrl = sanitizeUrl(`/${sanitizedUsername}`);
    res.redirect(sanitizedUrl);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/:username/unfollow', async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session.user) {
      return res.status(401).send('Unauthorized');
    }

    // Get whom_id from the database
    const username = req.params.username;

    // Sanitize input to prevent potential attacks
    const sanitizedUsername = sanitizeInput(username);

    const whom_id = await get_user_id(sanitizedUsername);
    if (!whom_id) {
      return res.status(404).send('User not found');
    }

    // Delete from follower table using parameterized queries to prevent SQL injection
    await execute('delete from follower where who_id=$1 and whom_id=$2', [req.session.user.user_id, whom_id]);
    req.flash('success', `You are no longer following "${sanitizedUsername}"`);

    // Redirect to the sanitized URL to prevent potential attacks
    const sanitizedUrl = sanitizeUrl(`/${sanitizedUsername}`);
    res.redirect(sanitizedUrl);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

app.listen(5000, () => {
  console.log('Minitwit running at port :5000')
})

function sanitizeInput(input) {
  // Replace single quotes with two single quotes to escape them in SQL queries
  const sanitizedInput = input.replace(/'/g, "''");
  return sanitizedInput;
}

function sanitizeUrl(url) {
  // Regular expression to match potentially dangerous characters in the URL
  const dangerousCharactersRegex = /[<>"'`]/g;

  // Replace potentially dangerous characters with their HTML entity equivalents
  const sanitizedUrl = url.replace(dangerousCharactersRegex, match => {
    switch (match) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      case '`':
        return '&#x60;';
      default:
        return match;
    }
  });
  return sanitizedUrl;
}

module.exports = app;


