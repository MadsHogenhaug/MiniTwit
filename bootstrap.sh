#!/bin/bash

set -e

echo -e "\n--> Bootstrapping Minitwit\n"

echo -e "\n--> Loading environment variables from secrets file\n"
source secrets/tf_secrets

echo -e "\n--> Checking that environment variables are set\n"
# check that all variables are set
[ -z "$TF_VAR_do_token" ] && echo "TF_VAR_do_token is not set" && exit
[ -z "$SPACE_NAME" ] && echo "SPACE_NAME is not set" && exit
[ -z "$STATE_FILE" ] && echo "STATE_FILE is not set" && exit
[ -z "$AWS_ACCESS_KEY_ID" ] && echo "AWS_ACCESS_KEY_ID is not set" && exit
[ -z "$AWS_SECRET_ACCESS_KEY" ] && echo "AWS_SECRET_ACCESS_KEY is not set" && exit

echo -e "\n--> Initializing terraform\n"
# initialize terraform
terraform -chdir=./terraform init \
    -backend-config "bucket=$SPACE_NAME" \
    -backend-config "key=$STATE_FILE" \
    -backend-config "access_key=$AWS_ACCESS_KEY_ID" \
    -backend-config "secret_key=$AWS_SECRET_ACCESS_KEY"

# check that everything looks good
echo -e "\n--> Validating terraform configuration\n"
terraform -chdir=./terraform validate

# create infrastructure
echo -e "\n--> Creating Infrastructure\n"
terraform -chdir=./terraform apply -auto-approve

# scp secrets
echo -e "\n--> Copying secrets to all nodes\n"

# Get the IP addresses from Terraform output
leader_ip=$(terraform -chdir=./terraform output -raw minitwit-swarm-leader-ip-address)
manager_ips=$(terraform -chdir=./terraform output -json minitwit-swarm-manager-ip-address | jq -r '.[]')
worker_ips=$(terraform -chdir=./terraform output -json minitwit-swarm-worker-ip-address | jq -r '.[]')

# Array to hold all IP addresses
all_ips=($leader_ip $manager_ips $worker_ips)

# Iterate over each IP address and copy the files
for ip in "${all_ips[@]}"; do
    echo -e "\n--> Copying secrets to $ip\n"
    scp -o 'StrictHostKeyChecking no' -r -i ssh_key/terraform ./secrets root@$ip:/root
done

# generate and scp the load balancer config
echo -e "\n--> Generating and copying the load balancer config\n"
bash load_balancer/gen_load_balancer_config.sh
bash load_balancer/scp_load_balancer_config.sh

# deploy the stack to the cluster
echo -e "\n--> Deploying the Minitwit stack to the cluster\n"
scp \
    -o 'StrictHostKeyChecking no' \
    -r \
    -i ssh_key/terraform \
    ./compose root@$(terraform -chdir=./terraform output -raw minitwit-swarm-leader-ip-address):/root
ssh \
    -o 'StrictHostKeyChecking no' \
    root@$(terraform -chdir=./terraform output -raw minitwit-swarm-leader-ip-address) \
    -i ssh_key/terraform \
    'docker stack deploy minitwit -c compose/compose.prod.yaml'

echo -e "\n--> Done bootstrapping Minitwit"
echo -e "--> Site will be avilable @ http://$(terraform -chdir=./terraform output -raw public_ip)"
echo -e "--> ssh to swarm leader with 'ssh root@$(terraform -chdir=./terraform output -raw minitwit-swarm-leader-ip-address) -i ssh_key/terraform'"
echo -e "--> To remove the infrastructure run: terraform destroy -auto-approve"
