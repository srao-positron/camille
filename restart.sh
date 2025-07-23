#!/bin/bash
# rm -rf ~/.camille/cache ~/.camille/logs ~/.camille/memory
camille server stop
camille server status
sudo npm uninstall -g claude-camille
npm run build && npm pack
sudo npm install -g claude-camille-0.3.2.tgz
camille server start > camille-output.log &
camille server status
