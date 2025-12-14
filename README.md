# PM2 Telegram Bot

A comprehensive Telegram bot for managing PM2 processes with real-time monitoring, auto-restart capabilities, and resource usage alerts.

## Features

### 🎛️ Process Management
- **Status Monitoring**: View all PM2 processes with CPU, memory, uptime, and restart counts
- **Process Control**: Start, stop, restart, and reload individual processes or all at once
- **Interactive Interface**: Use buttons or commands for easy process management

### 📊 Real-time Monitoring
- **Resource Monitoring**: Track CPU and memory usage for all processes
- **Threshold Alerts**: Get notified when processes exceed CPU/memory limits
- **Health Checks**: Automatic detection of stuck or unresponsive processes

### 🔄 Auto-restart System
- **Stuck Process Detection**: Automatically identifies processes that appear stuck
- **Smart Restart Logic**: Attempts to restart stuck processes with configurable retry limits
- **Alert System**: Notifies administrators of auto-restart actions and failures

### 🏥 Advanced Health Monitoring
- **Process Health Checks**: Comprehensive health monitoring with multiple detection methods
- **Stuck Process Detection**: Identifies processes with consistently low CPU activity
- **Memory Leak Detection**: Monitors for increasing memory usage patterns
- **Responsiveness Checks**: Uses PM2 ping to verify process responsiveness
- **Frequent Restart Detection**: Alerts on processes that restart too often
- **Group Chat Alerts**: Send alerts to Telegram groups for team notifications
- **Auto-restart on Health Failure**: Automatically restarts unhealthy processes

### 🔐 Security
- **User Authorization**: Only authorized users can control PM2 processes
- **Secure Commands**: All operations require proper authentication

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
```

## Usage

### Commands

- `/start` - Show welcome message and main menu
- `/status` - Display all PM2 processes status
- `/restart <name>` - Restart specific process
- `/stop <name>` - Stop specific process  
- `/start <name>` - Start specific process
- `/reload <name>` - Reload specific process (zero-downtime)
- `/logs <name>` - View process logs
- `/monitor` - Show monitoring status
- `/health` - Show health monitoring status
- `/healthtoggle` - Enable/disable health monitoring
- `/help` - Show help message

### Interactive Buttons

The bot provides an intuitive button interface for common operations:
- 📊 Status - View process status
- 🔄 Restart All - Restart all processes
- ⏹️ Stop All - Stop all processes
- ▶️ Start All - Start all processes
- 📈 Monitor - View monitoring dashboard
- 🏥 Health - View health monitoring status
- ⚙️ Settings - View bot configuration

### Monitoring Features

#### Automatic Alerts
- **High CPU Usage**: Alerts when any process exceeds the CPU threshold
- **High Memory Usage**: Alerts when any process exceeds the memory threshold
- **Stuck Process Detection**: Identifies and attempts to restart unresponsive processes

#### Auto-restart Logic
1. Detects processes that appear stuck (0% CPU for extended periods)
2. Attempts restart up to the configured threshold
3. Sends alerts for each restart attempt
4. Requires manual intervention after threshold is reached

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token from BotFather | Required |
| `AUTHORIZED_USERS` | Comma-separated list of user IDs | Required |
| `MONITOR_INTERVAL` | Monitoring check interval (ms) | 30000 |
| `CPU_THRESHOLD` | CPU usage alert threshold (%) | 80 |
| `MEMORY_THRESHOLD` | Memory usage alert threshold (MB) | 80 |
| `RESTART_THRESHOLD` | Max auto-restart attempts | 5 |
| `ALERT_GROUP_CHAT_ID` | Telegram group chat ID for alerts | Optional |
| `HEALTH_CHECK_ENABLED` | Enable health monitoring | true |
| `HEALTH_CHECK_INTERVAL` | Health check interval (ms) | 60000 |
| `STUCK_PROCESS_THRESHOLD` | Time before process considered stuck (ms) | 300000 |
| `MEMORY_LEAK_THRESHOLD` | Memory threshold for leak detection (MB) | 500 |
| `CPU_STUCK_THRESHOLD` | CPU threshold for stuck detection (%) | 0.1 |

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
3. **PM2 connection errors**: Ensure PM2 is installed and running
4. **Monitoring not working**: Check if the monitoring interval is set correctly

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