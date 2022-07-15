#! /bin/bash

NODE_VERSION=17.0.1

if [[ $UID -eq 0 ]]; then
	echo "[!] Don't run this as root."
	return 1
fi

# install compiler and cmake3, aliased to cmake
if [[ ! -f /usr/bin/cmake ]]; then
	echo "[*] Installing CMake3, C++"
	sudo yum install -y cmake3 gcc-c++ > /dev/null
	sudo ln -s /usr/bin/cmake3 /usr/bin/cmake
fi

# install nvm and node
if [[ ! -d /aws/mde/nvm ]]; then
	echo "[*] Installing NVM"
	sudo mkdir /aws/mde/nvm
	sudo chown cloudshell-user:cloudshell-user /aws/mde/nvm

	sudo ln -s /aws/mde/nvm ~/.nvm
	curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash > /dev/null
fi

export NVM_DIR="/aws/mde/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

echo "[*] Installing node.js ${NODE_VERSION}"
nvm install $NODE_VERSION > /dev/null
nvm alias default $NODE_VERSION
nvm use $NODE_VERSION

# Set up the larger storage environment:
if [[ ! -d /aws/mde/warcannon ]]; then
	sudo mkdir /aws/mde/warcannon
	sudo chown cloudshell-user:cloudshell-user /aws/mde/warcannon
fi

# Pull the repo:
if [[ ! -f /aws/mde/warcannon/README.md ]]; then
	echo "[*] Cloning the warcannon repo"
	git clone https://github.com/c6fc/warcannon.git /aws/mde/warcannon > /dev/null
fi

# Install Node and deploy.
cd /aws/mde/warcannon
[[ -z "${GIT_BRANCH}" ]] || git checkout $GIT_BRANCH
git pull

echo
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "[+] Installing Node.js prerequisites. This can take up to two minutes, and may appear frozen. DON'T INTERRUPT IT."
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo
echo

npm install > /dev/null
npm link > /dev/null

mv settings.json.sample settings.json

export PS1="\e[1m\e[32m@c6fc/warcannon>\e[0m "

echo "[+] Bootstrapping finished. Edit $PWD/settings.json and $PWD/lambda_functions/warcannon/matches.js then run"
echo "[+] [ warcannon deploy ]"
return 0