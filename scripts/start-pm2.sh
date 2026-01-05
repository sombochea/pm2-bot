#!/bin/bash

# Quick start script for PM2 Bot with self-protection
# This script ensures the bot is deployed with proper safeguards against infinite restart loops

set -e

echo "🚀 Starting PM2 Telegram Bot with Self-Protection..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Installing PM2..."
    npm install -g pm2
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "📝 Please edit .env file with your bot token and settings"
    echo "   Especially set BOT_TOKEN and AUTHORIZED_USERS"
    exit 1
fi

# Check if node_modules exists
if [ ! -d node_modules ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Stop any existing instance
echo "🛑 Stopping any existing bot instance..."
pm2 stop pm2-telegram-bot 2>/dev/null || true
pm2 delete pm2-telegram-bot 2>/dev/null || true

# Start with ecosystem config
echo "▶️  Starting bot with ecosystem config (self-protection enabled)..."
pm2 start ecosystem.config.js

# Save PM2 configuration
echo "💾 Saving PM2 configuration..."
pm2 save

# Display status
echo ""
echo "✅ Bot started successfully!"
echo ""
echo "📊 Status:"
pm2 status

echo ""
echo "📝 Logs:"
echo "  View logs: pm2 logs pm2-telegram-bot"
echo "  Error logs: pm2 logs pm2-telegram-bot --err"
echo ""
echo "🛡️  Self-protection: Bot will NOT manage itself during bulk operations"
echo "⚙️  Configuration: Check ecosystem.config.js for restart limits"
echo ""
echo "Useful commands:"
echo "  pm2 status              - Check bot status"
echo "  pm2 logs                - View all logs"
echo "  pm2 restart pm2-telegram-bot  - Restart bot"
echo "  pm2 stop pm2-telegram-bot      - Stop bot"
echo "  pm2 monit               - Monitor in real-time"
