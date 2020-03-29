#! /bin/bash

# Install NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.3/install.sh | bash
export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # This loads nvm

yum install -y htop git

nvm install 12
mkdir /tmp/warcannon
chmod 777 /tmp/warcannon

sudo mount -t tmpfs -o size=200g ramdisk /tmp/warcannon
git clone https://github.com/c6fc/warcannon.git