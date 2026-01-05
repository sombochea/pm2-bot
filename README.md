# PM2 Telegram Bot

A secure Telegram bot for managing PM2 processes with real-time monitoring and essential bulk operations. Refactored to use PM2 CLI commands for enhanced security and reliability.

## Features

### 🎛️ Process Management
- **Status Monitoring**: View all PM2 processes with CPU, memory, uptime, and restart counts
- **Bulk Operations**: Safely restart, stop, or start all processes with confirmation prompts
- **Interactive Interface**: Use buttons or commands for easy process management

### 📊 Real-time Monitoring
- **Resource Monitoring**: Track CPU and memory usage for all processes
- **Threshold Alerts**: Get notified when processes exceed CPU/memory limits
- **Health Monitoring**: Continuous monitoring of process health metrics

### 🔐 Enhanced Security
- **CLI-based Operations**: Uses secure PM2 CLI commands instead of Node API
- **User Authorization**: Only authorized users can control PM2 processes
- **Confirmation Prompts**: All bulk operations require explicit confirmation
- **Audit Logging**: Complete audit trail of all operations
- **Command Validation**: Prevents accidental process management

## Installation

1. **Clone and install dependencies:**
```bash
git clone https://github.com/sombochea/pm2-bot.git
cd pm2-telegram-bot
npm install
```

2. **Create environment file:**
```bash
cp .env.example .env
```

3. **Configure your bot:**
   - Get a bot token from [@BotFather](https://t.me/BotFather)
   - Add your Telegram user ID(s) to the authorized users list
   - Adjust monitoring thresholds as needed

4. **Edit `.env` file:**
```env
BOT_TOKEN=your_bot_token_here
AUTHORIZED_USERS=123456789,987654321
MONITOR_INTERVAL=30000
CPU_THRESHOLD=80
MEMORY_THRESHOLD=80
RESTART_THRESHOLD=5

# Self-protection (prevents infinite restart loops)
PM2_PROCESS_NAME=pm2-telegram-bot
EXCLUDE_SELF_FROM_OPERATIONS=true
```

## ⚠️ Critical: Preventing Infinite Restart Loops

When running the bot under PM2, it's crucial to prevent the bot from managing itself, which can cause infinite restart loops. The bot now includes **self-protection mechanisms**:

### How It Works
1. **Process Name Detection**: The bot detects its own PM2 process name via `PM2_PROCESS_NAME` environment variable
2. **Auto-Exclusion**: When executing bulk operations (restart all, stop all, start all), the bot automatically excludes itself
3. **Restart Limits**: PM2 is configured with restart limits and exponential backoff to prevent runaway restarts

### Deployment Options

#### Option 1: Using PM2 Ecosystem File (Recommended)
```bash
# Start with the provided ecosystem config
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

#### Option 2: Manual PM2 Start
```bash
# Start with explicit process name
pm2 start src/bot.js --name pm2-telegram-bot

# Set environment variable
pm2 set pm2-telegram-bot:PM2_PROCESS_NAME pm2-telegram-bot
pm2 set pm2-telegram-bot:EXCLUDE_SELF_FROM_OPERATIONS true

# Restart to apply changes
pm2 restart pm2-telegram-bot
```

#### Option 3: Direct Node.js (No Self-Protection Needed)
```bash
# If not running under PM2, just start normally
node src/bot.js
# or
npm start
```

### Verifying Self-Protection
Check the bot logs when it starts. You should see:
```
🛡️ Self-protection enabled: Bot process name = "pm2-telegram-bot" (PID: 12345)
```

If you see this warning instead, the bot cannot detect itself:
```
⚠️ Warning: Bot process name not detected. Set PM2_PROCESS_NAME env var to enable self-protection.
```

### Ecosystem Config Features
The `ecosystem.config.js` includes these safeguards:
- **max_restarts: 10** - Limits restart attempts
- **min_uptime: '10s'** - Requires 10s uptime before considering successful
- **restart_delay: 4000** - Waits 4s before restarting
- **exp_backoff_restart_delay** - Exponential backoff for repeated failures

```

## Usage

### Commands

**Essential Commands (Secure & Confirmed):**
- `/start` - Show welcome message and main menu
- `/status` - Display all PM2 processes status
- `/monitor` - Show detailed monitoring information
- `/restartall` - Restart all processes (with confirmation)
- `/stopall` - Stop all processes (with confirmation)
- `/startall` - Start all processes (with confirmation)
- `/auditlogs [lines]` - View audit logs
- `/clearaudit` - Clear audit logs
- `/help` - Show help message

### Interactive Buttons

The bot provides a secure button interface for essential operations:
- 📊 Status - View process status
- 📈 Monitor - View monitoring dashboard
- 🔄 Restart All - Restart all processes (with confirmation)
- ⏹️ Stop All - Stop all processes (with confirmation)
- ▶️ Start All - Start all processes (with confirmation)
- ⚙️ Settings - View bot configuration

### Security Features

#### Confirmation System
- **Bulk Operations**: All bulk operations require explicit confirmation
- **No Individual Process Control**: Prevents accidental single process management
- **Audit Trail**: Complete logging of all operations with user tracking

#### Monitoring Features
- **Resource Alerts**: Alerts when processes exceed CPU/memory thresholds
- **Health Monitoring**: Continuous monitoring without auto-restart interference
- **Safe Thresholds**: Configurable alerting without automatic actions

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token from BotFather | Required |
| `AUTHORIZED_USERS` | Comma-separated list of user IDs | Required |
| `AUTHORIZED_CHATS_FOR_ALERT` | Comma-separated list of chat IDs for alerts | Optional |
| `MONITOR_INTERVAL` | Monitoring check interval (ms) | 30000 |
| `CPU_THRESHOLD` | CPU usage alert threshold (%) | 80 |
| `MEMORY_THRESHOLD` | Memory usage alert threshold (MB) | 80 |
| `PM2_COMMAND_TIMEOUT` | PM2 CLI command timeout (ms) | 30000 |
| `AUDIT_LOGGING_ENABLED` | Enable audit logging (true/false) | false |
| `AUDIT_LOG_FILE` | Audit log file path | logs/bot-audit.log |
| `AUDIT_LOG_MAX_SIZE` | Max audit log file size (bytes) | 10485760 |
| `AUDIT_LOG_MAX_FILES` | Max number of audit log files | 5 |
| `AUDIT_LOG_MAX_LINES` | Max lines per audit log file | 10000 |

### Getting Your Telegram User ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. Copy your user ID to the `AUTHORIZED_USERS` environment variable

## Running the Bot

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### Using PM2 (Recommended)
```bash
pm2 start src/bot.js --name "telegram-pm2-bot"
pm2 save
pm2 startup
```

## Security Considerations

- Only authorized users can execute commands
- Bot token should be kept secure
- Consider running the bot on a secure server
- Regularly update dependencies

## Troubleshooting

### Common Issues

1. **Bot not responding**: Check if the bot token is correct
2. **Unauthorized access**: Verify your user ID is in the authorized users list
3. **PM2 CLI errors**: Ensure PM2 is installed and accessible via CLI
4. **Command timeouts**: Adjust `PM2_COMMAND_TIMEOUT` if operations are slow
5. **Monitoring not working**: Check if the monitoring interval is set correctly

### Security Notes

- **CLI-based**: Uses `pm2 jlist`, `pm2 restart all`, `pm2 stop all`, `pm2 start all` commands
- **No Individual Control**: Individual process management removed for safety
- **Confirmation Required**: All bulk operations require explicit confirmation
- **Audit Logging**: Enable audit logging to track all operations

### Logs

The bot logs important events to the console. For production, consider using a logging service or file logging.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License