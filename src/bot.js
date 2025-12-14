const { Bot, Keyboard, InlineKeyboard } = require('grammy');
const pm2 = require('pm2');
const cron = require('node-cron');
require('dotenv').config();

class PM2TelegramBot {
  constructor() {
    this.bot = new Bot(process.env.BOT_TOKEN);
    this.authorizedUsers = process.env.AUTHORIZED_USERS?.split(',').map(id => parseInt(id)) || [];
    this.monitorInterval = parseInt(process.env.MONITOR_INTERVAL) || 30000;
    this.cpuThreshold = parseInt(process.env.CPU_THRESHOLD) || 80;
    this.memoryThreshold = parseInt(process.env.MEMORY_THRESHOLD) || 80;
    this.restartThreshold = parseInt(process.env.RESTART_THRESHOLD) || 5;
    this.restartCounts = new Map();
    
    this.setupCommands();
    this.setupMiddleware();
    this.startMonitoring();
  }

  setupMiddleware() {
    // Authorization middleware
    this.bot.use((ctx, next) => {
      if (this.authorizedUsers.length === 0 || this.authorizedUsers.includes(ctx.from?.id)) {
        return next();
      }
      console.log('From chat', ctx.from)
      return ctx.reply('❌ Unauthorized access. Contact the administrator.');
    });
  }

  setupCommands() {
    // Start command
    this.bot.command('start', (ctx) => {
      const keyboard = new Keyboard()
        .text('📊 Status').text('🔄 Restart All').row()
        .text('⏹️ Stop All').text('▶️ Start All').row()
        .text('📈 Monitor').text('⚙️ Settings')
        .resized();
      
      ctx.reply(
        '🤖 *PM2 Management Bot*\\n\\n' +
        'Welcome, I can help you manage your PM2 processes\\.' +
        '\\n\\nUse the buttons below or these commands:' +
        '\\n• `/status` \\- Show all processes' +
        '\\n• `/restart <name>` \\- Restart specific app' +
        '\\n• `/stop <name>` \\- Stop specific app' +
        '\\n• `/start <name>` \\- Start specific app' +
        '\\n• `/reload <name>` \\- Reload specific app' +
        '\\n• `/logs <name>` \\- Show app logs' +
        '\\n• `/monitor` \\- Toggle monitoring' +
        '\\n• `/help` \\- Show this help',
        { 
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard
        }
      );
    });

    // Help command
    this.bot.command('help', (ctx) => this.bot.api.sendMessage(ctx.chat.id, '/start'));

    // Status command
    this.bot.command('status', (ctx) => this.getProcessStatus(ctx));
    this.bot.hears('📊 Status', (ctx) => this.getProcessStatus(ctx));

    // Restart commands
    this.bot.command('restart', (ctx) => this.restartProcess(ctx));
    this.bot.command('restartall', (ctx) => this.restartAllProcesses(ctx));
    this.bot.hears('🔄 Restart All', (ctx) => this.restartAllProcesses(ctx));

    // Stop commands
    this.bot.command('stop', (ctx) => this.stopProcess(ctx));
    this.bot.command('stopall', (ctx) => this.stopAllProcesses(ctx));
    this.bot.hears('⏹️ Stop All', (ctx) => this.stopAllProcesses(ctx));

    // Start commands
    this.bot.command('start', (ctx) => this.startProcess(ctx));
    this.bot.command('startall', (ctx) => this.startAllProcesses(ctx));
    this.bot.hears('▶️ Start All', (ctx) => this.startAllProcesses(ctx));

    // Reload command
    this.bot.command('reload', (ctx) => this.reloadProcess(ctx));

    // Logs command
    this.bot.command('logs', (ctx) => this.getProcessLogs(ctx));

    // Monitor command
    this.bot.command('monitor', (ctx) => this.toggleMonitoring(ctx));
    this.bot.hears('📈 Monitor', (ctx) => this.getMonitoringStatus(ctx));

    // Settings
    this.bot.hears('⚙️ Settings', (ctx) => this.showSettings(ctx));

    // Callback query handlers
    this.bot.on('callback_query', (ctx) => this.handleCallbackQuery(ctx));
  }
  async getProcessStatus(ctx) {
    try {
      const processes = await this.getPM2Processes();
      
      if (processes.length === 0) {
        return ctx.reply('📭 No PM2 processes found.');
      }

      let message = '📊 *PM2 Process Status*\\n\\n';
      
      processes.forEach(proc => {
        const status = proc.pm2_env.status;
        const statusIcon = status === 'online' ? '🟢' : status === 'stopped' ? '🔴' : '🟡';
        const cpu = proc.monit?.cpu || 0;
        const memory = proc.monit?.memory ? this.formatBytes(proc.monit.memory) : '0 MB';
        const uptime = proc.pm2_env.pm_uptime ? this.formatUptime(Date.now() - proc.pm2_env.pm_uptime) : 'N/A';
        const restarts = proc.pm2_env.restart_time || 0;

        message += `${statusIcon} *${proc.name}*\\n`;
        message += `   Status: \`${status}\`\\n`;
        message += `   CPU: \`${cpu}%\` \\| Memory: \`${memory}\`\\n`;
        message += `   Uptime: \`${uptime}\` \\| Restarts: \`${restarts}\`\\n\\n`;
      });

      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', 'refresh_status')
        .text('📈 Details', 'detailed_status');

      ctx.reply(message, { 
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard
      });
    } catch (error) {
      ctx.reply(`❌ Error getting process status: ${error.message}`);
    }
  }

  async restartProcess(ctx) {
    const processName = ctx.match?.trim();
    
    if (!processName) {
      const processes = await this.getPM2Processes();
      if (processes.length === 0) {
        return ctx.reply('📭 No processes available to restart.');
      }

      const keyboard = new InlineKeyboard();
      processes.forEach(proc => {
        keyboard.text(`🔄 ${proc.name}`, `restart_${proc.name}`).row();
      });

      return ctx.reply('🔄 Select a process to restart:', { reply_markup: keyboard });
    }

    try {
      await this.pm2Restart(processName);
      ctx.reply(`✅ Process "${processName}" restarted successfully.`);
    } catch (error) {
      ctx.reply(`❌ Failed to restart "${processName}": ${error.message}`);
    }
  }

  async restartAllProcesses(ctx) {
    try {
      await this.pm2RestartAll();
      ctx.reply('✅ All processes restarted successfully.');
    } catch (error) {
      ctx.reply(`❌ Failed to restart all processes: ${error.message}`);
    }
  }

  async stopProcess(ctx) {
    const processName = ctx.match?.trim();
    
    if (!processName) {
      const processes = await this.getPM2Processes();
      const runningProcesses = processes.filter(p => p.pm2_env.status === 'online');
      
      if (runningProcesses.length === 0) {
        return ctx.reply('📭 No running processes to stop.');
      }

      const keyboard = new InlineKeyboard();
      runningProcesses.forEach(proc => {
        keyboard.text(`⏹️ ${proc.name}`, `stop_${proc.name}`).row();
      });

      return ctx.reply('⏹️ Select a process to stop:', { reply_markup: keyboard });
    }

    try {
      await this.pm2Stop(processName);
      ctx.reply(`✅ Process "${processName}" stopped successfully.`);
    } catch (error) {
      ctx.reply(`❌ Failed to stop "${processName}": ${error.message}`);
    }
  }

  async stopAllProcesses(ctx) {
    try {
      await this.pm2StopAll();
      ctx.reply('✅ All processes stopped successfully.');
    } catch (error) {
      ctx.reply(`❌ Failed to stop all processes: ${error.message}`);
    }
  }

  async startProcess(ctx) {
    const processName = ctx.match?.trim();
    
    if (!processName) {
      const processes = await this.getPM2Processes();
      const stoppedProcesses = processes.filter(p => p.pm2_env.status === 'stopped');
      
      if (stoppedProcesses.length === 0) {
        return ctx.reply('📭 No stopped processes to start.');
      }

      const keyboard = new InlineKeyboard();
      stoppedProcesses.forEach(proc => {
        keyboard.text(`▶️ ${proc.name}`, `start_${proc.name}`).row();
      });

      return ctx.reply('▶️ Select a process to start:', { reply_markup: keyboard });
    }

    try {
      await this.pm2Start(processName);
      ctx.reply(`✅ Process "${processName}" started successfully.`);
    } catch (error) {
      ctx.reply(`❌ Failed to start "${processName}": ${error.message}`);
    }
  }

  async startAllProcesses(ctx) {
    try {
      await this.pm2StartAll();
      ctx.reply('✅ All processes started successfully.');
    } catch (error) {
      ctx.reply(`❌ Failed to start all processes: ${error.message}`);
    }
  }

  async reloadProcess(ctx) {
    const processName = ctx.match?.trim();
    
    if (!processName) {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(p => p.pm2_env.status === 'online');
      
      if (onlineProcesses.length === 0) {
        return ctx.reply('📭 No online processes to reload.');
      }

      const keyboard = new InlineKeyboard();
      onlineProcesses.forEach(proc => {
        keyboard.text(`🔄 ${proc.name}`, `reload_${proc.name}`).row();
      });

      return ctx.reply('🔄 Select a process to reload:', { reply_markup: keyboard });
    }

    try {
      await this.pm2Reload(processName);
      ctx.reply(`✅ Process "${processName}" reloaded successfully.`);
    } catch (error) {
      ctx.reply(`❌ Failed to reload "${processName}": ${error.message}`);
    }
  }
  async getProcessLogs(ctx) {
    const processName = ctx.match?.trim();
    
    if (!processName) {
      const processes = await this.getPM2Processes();
      if (processes.length === 0) {
        return ctx.reply('📭 No processes available.');
      }

      const keyboard = new InlineKeyboard();
      processes.forEach(proc => {
        keyboard.text(`📄 ${proc.name}`, `logs_${proc.name}`).row();
      });

      return ctx.reply('📄 Select a process to view logs:', { reply_markup: keyboard });
    }

    try {
      const logs = await this.getPM2Logs(processName);
      if (logs.length === 0) {
        return ctx.reply(`📄 No recent logs found for "${processName}".`);
      }

      const message = `📄 *Recent logs for ${processName}:*\n\n\`\`\`\n${logs.slice(-20).join('\n')}\n\`\`\``;
      ctx.reply(message, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      ctx.reply(`❌ Failed to get logs for "${processName}": ${error.message}`);
    }
  }

  async toggleMonitoring(ctx) {
    // This would toggle monitoring on/off
    ctx.reply('📈 Monitoring is currently active. Use /monitor to check status.');
  }

  async getMonitoringStatus(ctx) {
    try {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(p => p.pm2_env.status === 'online');
      
      if (onlineProcesses.length === 0) {
        return ctx.reply('📈 No online processes to monitor.');
      }

      let message = '📈 *Process Monitoring*\\n\\n';
      
      onlineProcesses.forEach(proc => {
        const cpu = proc.monit?.cpu || 0;
        const memory = proc.monit?.memory ? this.formatBytes(proc.monit.memory) : '0 MB';
        const cpuStatus = cpu > this.cpuThreshold ? '🔴' : cpu > 50 ? '🟡' : '🟢';
        const memoryMB = proc.monit?.memory ? Math.round(proc.monit.memory / 1024 / 1024) : 0;
        const memoryStatus = memoryMB > this.memoryThreshold ? '🔴' : memoryMB > 50 ? '🟡' : '🟢';

        message += `*${proc.name}*\\n`;
        message += `   CPU: ${cpuStatus} \`${cpu}%\`\\n`;
        message += `   Memory: ${memoryStatus} \`${memory}\`\\n`;
        message += `   PID: \`${proc.pid}\`\\n\\n`;
      });

      message += `\\n⚙️ *Thresholds:*\\n`;
      message += `CPU: \`${this.cpuThreshold}%\` \\| Memory: \`${this.memoryThreshold}MB\``;

      ctx.reply(message, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      ctx.reply(`❌ Error getting monitoring status: ${error.message}`);
    }
  }

  async showSettings(ctx) {
    const message = `⚙️ *Bot Settings*\\n\\n` +
      `Monitor Interval: \`${this.monitorInterval / 1000}s\`\\n` +
      `CPU Threshold: \`${this.cpuThreshold}%\`\\n` +
      `Memory Threshold: \`${this.memoryThreshold}MB\`\\n` +
      `Restart Threshold: \`${this.restartThreshold}\`\\n\\n` +
      `Authorized Users: \`${this.authorizedUsers.length}\``;

    ctx.reply(message, { parse_mode: 'MarkdownV2' });
  }

  async handleCallbackQuery(ctx) {
    const data = ctx.callbackQuery.data;
    
    if (data === 'refresh_status') {
      await this.getProcessStatus(ctx);
    } else if (data === 'detailed_status') {
      await this.getDetailedStatus(ctx);
    } else if (data.startsWith('restart_')) {
      const processName = data.replace('restart_', '');
      try {
        await this.pm2Restart(processName);
        ctx.answerCallbackQuery(`✅ ${processName} restarted`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to restart ${processName}`);
      }
    } else if (data.startsWith('stop_')) {
      const processName = data.replace('stop_', '');
      try {
        await this.pm2Stop(processName);
        ctx.answerCallbackQuery(`✅ ${processName} stopped`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to stop ${processName}`);
      }
    } else if (data.startsWith('start_')) {
      const processName = data.replace('start_', '');
      try {
        await this.pm2Start(processName);
        ctx.answerCallbackQuery(`✅ ${processName} started`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to start ${processName}`);
      }
    } else if (data.startsWith('reload_')) {
      const processName = data.replace('reload_', '');
      try {
        await this.pm2Reload(processName);
        ctx.answerCallbackQuery(`✅ ${processName} reloaded`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to reload ${processName}`);
      }
    } else if (data.startsWith('logs_')) {
      const processName = data.replace('logs_', '');
      await this.getProcessLogs({ match: processName, reply: ctx.reply.bind(ctx) });
    }
  }
  async getDetailedStatus(ctx) {
    try {
      const processes = await this.getPM2Processes();
      
      if (processes.length === 0) {
        return ctx.reply('📭 No PM2 processes found.');
      }

      let message = '📊 *Detailed Process Status*\\n\\n';
      
      processes.forEach(proc => {
        const env = proc.pm2_env;
        const status = env.status;
        const statusIcon = status === 'online' ? '🟢' : status === 'stopped' ? '🔴' : '🟡';
        
        message += `${statusIcon} *${proc.name}* \\(ID: ${proc.pm_id}\\)\\n`;
        message += `   Status: \`${status}\`\\n`;
        message += `   PID: \`${proc.pid || 'N/A'}\`\\n`;
        message += `   CPU: \`${proc.monit?.cpu || 0}%\`\\n`;
        message += `   Memory: \`${proc.monit?.memory ? this.formatBytes(proc.monit.memory) : '0 MB'}\`\\n`;
        message += `   Uptime: \`${env.pm_uptime ? this.formatUptime(Date.now() - env.pm_uptime) : 'N/A'}\`\\n`;
        message += `   Restarts: \`${env.restart_time || 0}\`\\n`;
        message += `   Script: \`${env.pm_exec_path || 'N/A'}\`\\n`;
        message += `   Mode: \`${env.exec_mode || 'N/A'}\`\\n\\n`;
      });

      ctx.reply(message, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      ctx.reply(`❌ Error getting detailed status: ${error.message}`);
    }
  }

  startMonitoring() {
    // Monitor every 30 seconds (or configured interval)
    setInterval(async () => {
      try {
        await this.checkProcessHealth();
      } catch (error) {
        console.error('Monitoring error:', error);
      }
    }, this.monitorInterval);

    console.log(`🔍 Monitoring started with ${this.monitorInterval / 1000}s interval`);
  }

  async checkProcessHealth() {
    try {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(p => p.pm2_env.status === 'online');

      for (const proc of onlineProcesses) {
        const cpu = proc.monit?.cpu || 0;
        const memoryMB = proc.monit?.memory ? Math.round(proc.monit.memory / 1024 / 1024) : 0;
        const processName = proc.name;

        // Check for high CPU usage
        if (cpu > this.cpuThreshold) {
          await this.sendAlert(`🔴 High CPU Alert: ${processName} is using ${cpu}% CPU`);
        }

        // Check for high memory usage
        if (memoryMB > this.memoryThreshold) {
          await this.sendAlert(`🔴 High Memory Alert: ${processName} is using ${memoryMB}MB memory`);
        }

        // Check for stuck processes (not responding)
        if (await this.isProcessStuck(proc)) {
          await this.handleStuckProcess(proc);
        }
      }
    } catch (error) {
      console.error('Health check error:', error);
    }
  }

  async isProcessStuck(proc) {
    // Simple heuristic: if CPU is 0 for extended period and should be active
    const cpu = proc.monit?.cpu || 0;
    const uptime = Date.now() - proc.pm2_env.pm_uptime;
    
    // If process has been running for more than 5 minutes with 0% CPU consistently
    return uptime > 300000 && cpu === 0 && proc.pm2_env.status === 'online';
  }

  async handleStuckProcess(proc) {
    const processName = proc.name;
    const currentCount = this.restartCounts.get(processName) || 0;

    if (currentCount < this.restartThreshold) {
      try {
        await this.pm2Restart(processName);
        this.restartCounts.set(processName, currentCount + 1);
        await this.sendAlert(`🔄 Auto-restarted stuck process: ${processName} (attempt ${currentCount + 1}/${this.restartThreshold})`);
      } catch (error) {
        await this.sendAlert(`❌ Failed to auto-restart ${processName}: ${error.message}`);
      }
    } else {
      await this.sendAlert(`⚠️ Process ${processName} has been restarted ${this.restartThreshold} times. Manual intervention required.`);
      // Reset counter after reaching threshold
      this.restartCounts.set(processName, 0);
    }
  }

  async sendAlert(message) {
    // Send alert to all authorized users
    for (const userId of this.authorizedUsers) {
      try {
        await this.bot.api.sendMessage(userId, `🚨 *PM2 Alert*\\n\\n${message}`, { 
          parse_mode: 'MarkdownV2' 
        });
      } catch (error) {
        console.error(`Failed to send alert to user ${userId}:`, error);
      }
    }
  }
  // PM2 wrapper methods
  async getPM2Processes() {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.list((err, processes) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve(processes);
        });
      });
    });
  }

  async pm2Restart(processName) {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.restart(processName, (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async pm2RestartAll() {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.restart('all', (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async pm2Stop(processName) {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.stop(processName, (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async pm2StopAll() {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.stop('all', (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async pm2Start(processName) {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.start(processName, (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async pm2StartAll() {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.start('all', (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async pm2Reload(processName) {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.reload(processName, (err) => {
          pm2.disconnect();
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  async getPM2Logs(processName) {
    // This is a simplified version - in production you might want to read actual log files
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        // PM2 doesn't have a direct logs API, so we'll return a placeholder
        pm2.disconnect();
        resolve([`[${new Date().toISOString()}] Log entry for ${processName}`]);
      });
    });
  }

  // Utility methods
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  start() {
    this.bot.start({
      onStart: (botInfo) => {
        console.log(`🤖 Bot @${botInfo.username} started successfully.`);
        console.log(`📊 Monitoring ${this.authorizedUsers.length} authorized users`);
        console.log(`⚙️ CPU threshold: ${this.cpuThreshold}%, Memory threshold: ${this.memoryThreshold}MB`);
      }
    });
  }
}

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot
const bot = new PM2TelegramBot();
bot.start();