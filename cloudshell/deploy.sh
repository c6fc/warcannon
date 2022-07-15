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
if [[ ! -f $(which n) ]]; then
	echo "[*] Installing @tj/n"
	mkdir ~/bin
	curl -L https://raw.githubusercontent.com/tj/n/master/bin/n -o ~/bin/n
	chmod +x ~/bin/n
fi

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

# Run the deploy:
cd /aws/mde/warcannon
git pull

echo
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "[+] Installing Node.js prerequisites. This can take up to two minutes, and may appear frozen. DON'T INTERRUPT IT."
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo
echo

npm install -g > /dev/null

bash -c "npm run deploy < /dev/tty"

cd /aws/mde/warcannon
export PS1="\e[1m\e[32m@c6fc/warcannon>\e[0m "

echo "[+] Bootstrapping finished. Edit $PWD/lambda_functions/warcannon/matches.js then run\n"
echo "[+] [ warcannon deploy ]"
return 0