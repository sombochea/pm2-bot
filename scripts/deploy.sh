#!/bin/bash

# PM2 Telegram Bot Deployment Script with Self-Protection
# This script deploys the bot with proper PM2 configuration to prevent infinite restart loops

# Default values
SERVER=""
DEST="~/apps/pm2-bot"
USER="root"
SSH_PRIVATE_KEY=""
APP_NAME="pm2-telegram-bot"  # Changed default to match ecosystem config

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --server)
            SERVER="$2"
            shift 2
            ;;
        --dest)
            DEST="$2"
            shift 2
            ;;
        --user)
            USER="$2"
            shift 2
            ;;
        --ssh-private-key)
            SSH_PRIVATE_KEY="$2"
            shift 2
            ;;
        --app-name)
            APP_NAME="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 --server <ip> --dest <path> [--user <username>] [--ssh-private-key <path>] [--app-name <name>]"
            echo "  --server          Target server IP address"
            echo "  --dest            Destination folder on remote server"
            echo "  --user            SSH user (default: root)"
            echo "  --ssh-private-key Path to SSH private key file"
            echo "  --app-name        PM2 application name (default: bot)"
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$SERVER" ]]; then
    echo "Error: --server is required"
    exit 1
fi

if [[ -z "$DEST" ]]; then
    echo "Error: --dest is required"
    exit 1
fi

# Build SSH options
SSH_OPTS="-o StrictHostKeyChecking=no"
if [[ -n "$SSH_PRIVATE_KEY" ]]; then
    SSH_OPTS="$SSH_OPTS -i $SSH_PRIVATE_KEY"
fi

echo "Deploying PM2 Node.js application to $USER@$SERVER:$DEST"

# Create destination directory if it doesn't exist
ssh $SSH_OPTS $USER@$SERVER "mkdir -p $DEST"

# Copy specific application files to remote server
rsync -avz -e "ssh $SSH_OPTS" src/ package.json package-lock.json ecosystem.config.js .env $USER@$SERVER:$DEST/
# Set permissions
ssh $SSH_OPTS $USER@$SERVER "chmod -R 755 $DEST"

# Install npm dependencies
echo "Installing npm dependencies..."
ssh $SSH_OPTS $USER@$SERVER "cd $DEST && npm install"

# Start/restart the application with PM2 using ecosystem config
echo "Starting application with PM2 (with self-protection)..."
ssh $SSH_OPTS $USER@$SERVER << EOF
cd $DEST

# Stop old instance if exists
pm2 stop $APP_NAME 2>/dev/null || true
pm2 delete $APP_NAME 2>/dev/null || true

# Start with ecosystem config (includes self-protection)
pm2 start ecosystem.config.js

# Save PM2 process list
pm2 save

echo "✅ Deployment complete! Bot is running with self-protection enabled."
echo "📝 Check logs: pm2 logs $APP_NAME"
echo "📊 Check status: pm2 status"
EOF
ssh $SSH_OPTS $USER@$SERVER "cd $DEST && pm2 delete $APP_NAME 2>/dev/null || true; pm2 start bot.js --name $APP_NAME && pm2 save"
echo "PM2 Node.js deployment completed successfully!"
