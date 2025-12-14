require("dotenv").config();

const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const pm2 = require("pm2");
const cron = require("node-cron");
const { exec } = require("child_process");
const axios = require("axios");

class PM2TelegramBot {
  constructor() {
    this.bot = new Bot(process.env.BOT_TOKEN);
    this.authorizedUsers =
      process.env.AUTHORIZED_USERS?.split(",").map((id) => parseInt(id)) || [];
    this.alertGroupChatId = process.env.ALERT_GROUP_CHAT_ID || null;
    
    // Basic monitoring settings
    this.monitorInterval = parseInt(process.env.MONITOR_INTERVAL) || 30000;
    this.cpuThreshold = parseInt(process.env.CPU_THRESHOLD) || 80;
    this.memoryThreshold = parseInt(process.env.MEMORY_THRESHOLD) || 80;
    this.restartThreshold = parseInt(process.env.RESTART_THRESHOLD) || 5;
    this.restartCounts = new Map();
    
    // Health check settings
    this.healthCheckEnabled = process.env.HEALTH_CHECK_ENABLED === 'true';
    this.healthCheckInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000;
    this.stuckProcessThreshold = parseInt(process.env.STUCK_PROCESS_THRESHOLD) || 300000; // 5 minutes
    this.memoryLeakThreshold = parseInt(process.env.MEMORY_LEAK_THRESHOLD) || 500; // MB
    this.cpuStuckThreshold = parseFloat(process.env.CPU_STUCK_THRESHOLD) || 0.1; // 0.1%
    
    // HTTP Health check settings
    this.httpHealthCheckEnabled = process.env.HTTP_HEALTH_CHECK_ENABLED === 'true';
    this.defaultHealthEndpoint = process.env.DEFAULT_HEALTH_ENDPOINT || '/debug/health';
    this.healthCheckTimeout = parseInt(process.env.HEALTH_CHECK_TIMEOUT) || 5000;
    this.healthCheckPort = parseInt(process.env.HEALTH_CHECK_PORT) || 3000;
    
    // Parse app-specific health endpoints
    this.appHealthEndpoints = new Map();
    try {
      const appEndpoints = process.env.APP_HEALTH_ENDPOINTS;
      if (appEndpoints) {
        const parsed = JSON.parse(appEndpoints);
        Object.entries(parsed).forEach(([app, endpoint]) => {
          this.appHealthEndpoints.set(app, endpoint);
        });
      }
    } catch (error) {
      console.warn('Failed to parse APP_HEALTH_ENDPOINTS:', error.message);
    }
    
    // Health monitoring data
    this.processHealthHistory = new Map();
    this.alertCooldowns = new Map();
    this.healthCheckRunning = false;

    this.setupCommands();
    this.setupMiddleware();
    this.startMonitoring();
    if (this.healthCheckEnabled) {
      this.startHealthMonitoring();
    }
  }

  setupMiddleware() {
    // Authorization middleware
    this.bot.use((ctx, next) => {
      if (
        this.authorizedUsers.length === 0 ||
        this.authorizedUsers.includes(ctx.from?.id) ||
        this.authorizedUsers.includes(ctx.from?.username)
      ) {
        return next();
      }
      console.log("Unauthorized from chat", ctx.from);
      return ctx.reply("❌ Unauthorized access. Contact the administrator.");
    });
  }

  setupCommands() {
    // Start command
    this.bot.command("start", (ctx) => {
      const keyboard = new Keyboard()
        .text("📊 Status")
        .text("🔄 Restart All")
        .row()
        .text("⏹️ Stop All")
        .text("▶️ Start All")
        .row()
        .text("📈 Monitor")
        .text("🏥 Health")
        .row()
        .text("⚙️ Settings")
        .resized();

      ctx.reply(
        "🤖 <b>PM2 Management Bot</b>\n\n" +
        "Welcome! I can help you manage your PM2 processes.\n\n" +
        "Use the buttons below or these commands:\n" +
        "• <code>/status</code> - Show all processes\n" +
        "• <code>/restart &lt;name&gt;</code> - Restart specific app\n" +
        "• <code>/stop &lt;name&gt;</code> - Stop specific app\n" +
        "• <code>/start &lt;name&gt;</code> - Start specific app\n" +
        "• <code>/reload &lt;name&gt;</code> - Reload specific app\n" +
        "• <code>/logs &lt;name&gt;</code> - Show app logs\n" +
        "• <code>/monitor</code> - Toggle monitoring\n" +
        "• <code>/health</code> - Show health status\n" +
        "• <code>/healthtoggle</code> - Toggle health monitoring\n" +
        "• <code>/healthcheck</code> - Manual health check\n" +
        "• <code>/setendpoint</code> - Set custom health endpoint\n" +
        "• <code>/endpoints</code> - List health endpoints\n" +
        "• <code>/help</code> - Show this help",
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    });

    // Help command
    this.bot.command("help", (ctx) =>
      this.bot.api.sendMessage(ctx.chat.id, "/start")
    );

    // Status command
    this.bot.command("status", (ctx) => this.getProcessStatus(ctx));
    this.bot.hears("📊 Status", (ctx) => this.getProcessStatus(ctx));

    // Restart commands
    this.bot.command("restart", (ctx) => this.restartProcess(ctx));
    this.bot.command("restartall", (ctx) => this.restartAllProcesses(ctx));
    this.bot.hears("🔄 Restart All", (ctx) => this.restartAllProcesses(ctx));

    // Stop commands
    this.bot.command("stop", (ctx) => this.stopProcess(ctx));
    this.bot.command("stopall", (ctx) => this.stopAllProcesses(ctx));
    this.bot.hears("⏹️ Stop All", (ctx) => this.stopAllProcesses(ctx));

    // Start commands
    this.bot.command("start", (ctx) => this.startProcess(ctx));
    this.bot.command("startall", (ctx) => this.startAllProcesses(ctx));
    this.bot.hears("▶️ Start All", (ctx) => this.startAllProcesses(ctx));

    // Reload command
    this.bot.command("reload", (ctx) => this.reloadProcess(ctx));

    // Logs command
    this.bot.command("logs", (ctx) => this.getProcessLogs(ctx));

    // Monitor command
    this.bot.command("monitor", (ctx) => this.toggleMonitoring(ctx));
    this.bot.hears("📈 Monitor", (ctx) => this.getMonitoringStatus(ctx));

    // Health monitoring commands
    this.bot.command("health", (ctx) => this.getHealthStatus(ctx));
    this.bot.command("healthtoggle", (ctx) => this.toggleHealthMonitoring(ctx));
    this.bot.command("healthcheck", (ctx) => this.manualHealthCheck(ctx));
    this.bot.command("setendpoint", (ctx) => this.setHealthEndpoint(ctx));
    this.bot.command("endpoints", (ctx) => this.listHealthEndpoints(ctx));
    this.bot.hears("🏥 Health", (ctx) => this.getHealthStatus(ctx));

    // Settings
    this.bot.hears("⚙️ Settings", (ctx) => this.showSettings(ctx));

    // Callback query handlers
    this.bot.on("callback_query", (ctx) => this.handleCallbackQuery(ctx));
  }
  async getProcessStatus(ctx) {
    try {
      const processes = await this.getPM2Processes();

      if (processes.length === 0) {
        return ctx.reply("📭 No PM2 processes found.");
      }

      let message = "📊 <b>PM2 Process Status</b>\n\n";

      processes.forEach((proc) => {
        const status = proc.pm2_env.status;
        const statusIcon =
          status === "online" ? "🟢" : status === "stopped" ? "🔴" : "🟡";
        const cpu = proc.monit?.cpu || 0;
        const memory = proc.monit?.memory
          ? this.formatBytes(proc.monit.memory)
          : "0 MB";
        const uptime = proc.pm2_env.pm_uptime
          ? this.formatUptime(Date.now() - proc.pm2_env.pm_uptime)
          : "N/A";
        const restarts = proc.pm2_env.restart_time || 0;

        message += `${statusIcon} <b>${proc.name}</b>\n`;
        message += `   Status: <code>${status}</code>\n`;
        message += `   CPU: <code>${cpu}%</code> | Memory: <code>${memory}</code>\n`;
        message += `   Uptime: <code>${uptime}</code> | Restarts: <code>${restarts}</code>\n\n`;
      });

      // Create keyboard with individual app controls
      const keyboard = new InlineKeyboard();

      // Add individual app controls
      processes.forEach((proc) => {
        const status = proc.pm2_env.status;
        const name = proc.name;

        if (status === "online") {
          // For online processes: restart, reload, stop, logs
          keyboard
            .text(`🔄 ${name}`, `restart_${name}`)
            .text(`🔃 ${name}`, `reload_${name}`)
            .row()
            .text(`⏹️ ${name}`, `stop_${name}`)
            .text(`📄 ${name}`, `logs_${name}`)
            .row();
        } else {
          // For stopped processes: start, logs
          keyboard
            .text(`▶️ ${name}`, `start_${name}`)
            .text(`📄 ${name}`, `logs_${name}`)
            .row();
        }
      });

      // Add general controls
      keyboard
        .text("🔄 Refresh", "refresh_status")
        .text("📈 Details", "detailed_status")
        .row()
        .text("🔄 Restart All", "restart_all")
        .text("⏹️ Stop All", "stop_all");

      ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
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
        return ctx.reply("📭 No processes available to restart.");
      }

      const keyboard = new InlineKeyboard();
      processes.forEach((proc) => {
        keyboard.text(`🔄 ${proc.name}`, `restart_${proc.name}`).row();
      });

      return ctx.reply("🔄 Select a process to restart:", {
        reply_markup: keyboard,
      });
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
      ctx.reply("✅ All processes restarted successfully.");
    } catch (error) {
      ctx.reply(`❌ Failed to restart all processes: ${error.message}`);
    }
  }

  async stopProcess(ctx) {
    const processName = ctx.match?.trim();

    if (!processName) {
      const processes = await this.getPM2Processes();
      const runningProcesses = processes.filter(
        (p) => p.pm2_env.status === "online"
      );

      if (runningProcesses.length === 0) {
        return ctx.reply("📭 No running processes to stop.");
      }

      const keyboard = new InlineKeyboard();
      runningProcesses.forEach((proc) => {
        keyboard.text(`⏹️ ${proc.name}`, `stop_${proc.name}`).row();
      });

      return ctx.reply("⏹️ Select a process to stop:", {
        reply_markup: keyboard,
      });
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
      ctx.reply("✅ All processes stopped successfully.");
    } catch (error) {
      ctx.reply(`❌ Failed to stop all processes: ${error.message}`);
    }
  }

  async startProcess(ctx) {
    const processName = ctx.match?.trim();

    if (!processName) {
      const processes = await this.getPM2Processes();
      const stoppedProcesses = processes.filter(
        (p) => p.pm2_env.status === "stopped"
      );

      if (stoppedProcesses.length === 0) {
        return ctx.reply("📭 No stopped processes to start.");
      }

      const keyboard = new InlineKeyboard();
      stoppedProcesses.forEach((proc) => {
        keyboard.text(`▶️ ${proc.name}`, `start_${proc.name}`).row();
      });

      return ctx.reply("▶️ Select a process to start:", {
        reply_markup: keyboard,
      });
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
      ctx.reply("✅ All processes started successfully.");
    } catch (error) {
      ctx.reply(`❌ Failed to start all processes: ${error.message}`);
    }
  }

  async reloadProcess(ctx) {
    const processName = ctx.match?.trim();

    if (!processName) {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(
        (p) => p.pm2_env.status === "online"
      );

      if (onlineProcesses.length === 0) {
        return ctx.reply("📭 No online processes to reload.");
      }

      const keyboard = new InlineKeyboard();
      onlineProcesses.forEach((proc) => {
        keyboard.text(`🔄 ${proc.name}`, `reload_${proc.name}`).row();
      });

      return ctx.reply("🔄 Select a process to reload:", {
        reply_markup: keyboard,
      });
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
        return ctx.reply("📭 No processes available.");
      }

      const keyboard = new InlineKeyboard();
      processes.forEach((proc) => {
        keyboard.text(`📄 ${proc.name}`, `logs_${proc.name}`).row();
      });

      return ctx.reply("📄 Select a process to view logs:", {
        reply_markup: keyboard,
      });
    }

    try {
      const logs = await this.getPM2Logs(processName);
      if (logs.length === 0) {
        return ctx.reply(`📄 No recent logs found for "${processName}".`);
      }

      // Limit message length to avoid Telegram's 4096 character limit
      const logText = logs.join('\n');
      const maxLength = 3500; // Leave room for the header and formatting

      let displayLogs = logText;
      if (logText.length > maxLength) {
        displayLogs = '...\n' + logText.slice(-maxLength);
      }

      const message = `📄 <b>Recent logs for ${processName}:</b>\n\n<pre>${displayLogs}</pre>`;

      // Add refresh button for logs
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Logs', `logs_${processName}`)
        .text('📊 Back to Status', 'refresh_status');

      ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    } catch (error) {
      ctx.reply(`❌ Failed to get logs for "${processName}": ${error.message}`);
    }
  }

  async showProcessLogs(ctx, processName, lines = 20) {
    try {
      ctx.answerCallbackQuery(`📄 Getting ${lines} lines of logs...`);

      const logs = await this.getPM2Logs(processName, lines);
      if (logs.length === 0) {
        return ctx.reply(`📄 No recent logs found for "${processName}".`);
      }

      // Limit message length to avoid Telegram's 4096 character limit
      const logText = logs.join('\n');
      const maxLength = 3500; // Leave room for the header and formatting

      let displayLogs = logText;
      if (logText.length > maxLength) {
        displayLogs = '...\n' + logText.slice(-maxLength);
      }

      const message = `📄 <b>Recent ${lines} lines for ${processName}:</b>\n\n<pre>${displayLogs}</pre>`;

      // Add action buttons
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', `viewlogs_${processName}_${lines}`)
        .text('🔴 Error Logs', `errorlogs_${processName}`)
        .row()
        .text('📊 Back to Status', 'refresh_status')
        .text('📄 Log Menu', `logs_${processName}`);

      ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    } catch (error) {
      ctx.reply(`❌ Failed to get logs for "${processName}": ${error.message}`);
    }
  }

  async showProcessErrorLogs(ctx, processName) {
    try {
      ctx.answerCallbackQuery('🔴 Getting error logs...');

      const errorLogs = await this.getPM2ErrorLogs(processName, 15);
      if (errorLogs.length === 0) {
        return ctx.reply(`🔴 No recent error logs found for "${processName}".`);
      }

      // Limit message length
      const logText = errorLogs.join('\n');
      const maxLength = 3500;

      let displayLogs = logText;
      if (logText.length > maxLength) {
        displayLogs = '...\n' + logText.slice(-maxLength);
      }

      const message = `🔴 <b>Error logs for ${processName}:</b>\n\n<pre>${displayLogs}</pre>`;

      // Add action buttons
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Errors', `errorlogs_${processName}`)
        .text('📄 All Logs', `viewlogs_${processName}_20`)
        .row()
        .text('📊 Back to Status', 'refresh_status')
        .text('📄 Log Menu', `logs_${processName}`);

      ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    } catch (error) {
      ctx.reply(`❌ Failed to get error logs for "${processName}": ${error.message}`);
    }
  }

  async toggleMonitoring(ctx) {
    // This would toggle monitoring on/off
    ctx.reply(
      "📈 Monitoring is currently active. Use /monitor to check status."
    );
  }

  async getMonitoringStatus(ctx) {
    try {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(
        (p) => p.pm2_env.status === "online"
      );

      if (onlineProcesses.length === 0) {
        return ctx.reply("📈 No online processes to monitor.");
      }

      let message = "📈 <b>Process Monitoring</b>\n\n";

      onlineProcesses.forEach((proc) => {
        const cpu = proc.monit?.cpu || 0;
        const memory = proc.monit?.memory
          ? this.formatBytes(proc.monit.memory)
          : "0 MB";
        const cpuStatus =
          cpu > this.cpuThreshold ? "🔴" : cpu > 50 ? "🟡" : "🟢";
        const memoryMB = proc.monit?.memory
          ? Math.round(proc.monit.memory / 1024 / 1024)
          : 0;
        const memoryStatus =
          memoryMB > this.memoryThreshold ? "🔴" : memoryMB > 50 ? "🟡" : "🟢";

        message += `<b>${proc.name}</b>\n`;
        message += `   CPU: ${cpuStatus} <code>${cpu}%</code>\n`;
        message += `   Memory: ${memoryStatus} <code>${memory}</code>\n`;
        message += `   PID: <code>${proc.pid}</code>\n\n`;
      });

      message += `\n⚙️ <b>Thresholds:</b>\n`;
      message += `CPU: <code>${this.cpuThreshold}%</code> | Memory: <code>${this.memoryThreshold}MB</code>`;

      ctx.reply(message, { parse_mode: "HTML" });
    } catch (error) {
      ctx.reply(`❌ Error getting monitoring status: ${error.message}`);
    }
  }

  async showSettings(ctx) {
    const message =
      `⚙️ <b>Bot Settings</b>\n\n` +
      `Monitor Interval: <code>${this.monitorInterval / 1000}s</code>\n` +
      `CPU Threshold: <code>${this.cpuThreshold}%</code>\n` +
      `Memory Threshold: <code>${this.memoryThreshold}MB</code>\n` +
      `Restart Threshold: <code>${this.restartThreshold}</code>\n\n` +
      `Health Monitoring: <code>${this.healthCheckEnabled ? 'Enabled' : 'Disabled'}</code>\n` +
      `HTTP Health Checks: <code>${this.httpHealthCheckEnabled ? 'Enabled' : 'Disabled'}</code>\n` +
      `Health Check Interval: <code>${this.healthCheckInterval / 1000}s</code>\n` +
      `Default Endpoint: <code>${this.defaultHealthEndpoint}</code>\n` +
      `Default Port: <code>${this.healthCheckPort}</code>\n` +
      `Request Timeout: <code>${this.healthCheckTimeout}ms</code>\n` +
      `Custom Endpoints: <code>${this.appHealthEndpoints.size}</code>\n` +
      `Group Chat Alerts: <code>${this.alertGroupChatId ? 'Enabled' : 'Disabled'}</code>\n\n` +
      `Authorized Users: <code>${this.authorizedUsers.length}</code>`;

    ctx.reply(message, { parse_mode: "HTML" });
  }

  async getHealthStatus(ctx) {
    if (!this.healthCheckEnabled) {
      return ctx.reply('🏥 Health monitoring is currently disabled. Use /healthtoggle to enable it.');
    }

    try {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(p => p.pm2_env.status === 'online');
      
      if (onlineProcesses.length === 0) {
        return ctx.reply('🏥 No online processes to monitor.');
      }

      let message = '🏥 <b>Process Health Status</b>\n\n';
      
      onlineProcesses.forEach(proc => {
        const processName = proc.name;
        const health = this.processHealthHistory.get(processName);
        
        if (health) {
          const timeSinceHealthy = Math.round((Date.now() - health.lastHealthyTime) / 1000);
          const healthIcon = health.consecutiveUnhealthyChecks === 0 ? '🟢' : 
                           health.consecutiveUnhealthyChecks < 3 ? '🟡' : '🔴';
          
          message += `${healthIcon} <b>${processName}</b>\n`;
          message += `   Last healthy: <code>${timeSinceHealthy}s ago</code>\n`;
          message += `   Unhealthy checks: <code>${health.consecutiveUnhealthyChecks}</code>\n`;
          
          if (this.httpHealthCheckEnabled) {
            const endpoint = this.getHealthEndpointForApp(processName);
            message += `   Endpoint: <code>${endpoint}</code>\n`;
            message += `   Last status: <code>${health.lastHttpStatus || 'N/A'}</code>\n`;
            if (health.lastResponseTime) {
              message += `   Response time: <code>${health.lastResponseTime}ms</code>\n`;
            }
          }
          
          message += `   Auto-restarts: <code>${this.restartCounts.get(processName) || 0}/${this.restartThreshold}</code>\n\n`;
        } else {
          message += `🟡 <b>${processName}</b>\n`;
          message += `   Status: <code>No health data yet</code>\n`;
          if (this.httpHealthCheckEnabled) {
            const endpoint = this.getHealthEndpointForApp(processName);
            message += `   Endpoint: <code>${endpoint}</code>\n`;
          }
          message += `\n`;
        }
      });

      message += `\n⚙️ <b>Health Settings:</b>\n`;
      message += `Check Interval: <code>${this.healthCheckInterval / 1000}s</code>\n`;
      message += `Stuck Threshold: <code>${this.stuckProcessThreshold / 1000}s</code>\n`;
      message += `Memory Leak Threshold: <code>${this.memoryLeakThreshold}MB</code>`;

      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Health', 'refresh_health')
        .text('📊 Process Status', 'refresh_status');

      ctx.reply(message, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (error) {
      ctx.reply(`❌ Error getting health status: ${error.message}`);
    }
  }

  async toggleHealthMonitoring(ctx) {
    this.healthCheckEnabled = !this.healthCheckEnabled;
    
    if (this.healthCheckEnabled) {
      this.startHealthMonitoring();
      ctx.reply('🏥 ✅ Health monitoring enabled! The bot will now monitor process health and send alerts.');
    } else {
      ctx.reply('🏥 ⏹️ Health monitoring disabled. No automatic health checks will be performed.');
    }
  }

  async manualHealthCheck(ctx) {
    ctx.reply('🏥 Running manual health check...');
    
    try {
      await this.performHealthCheck();
      ctx.reply('✅ Manual health check completed successfully. Check logs for details.');
    } catch (error) {
      ctx.reply(`❌ Manual health check failed: ${error.message}`);
      console.error('Manual health check error:', error);
    }
  }

  async setHealthEndpoint(ctx) {
    const args = ctx.match?.trim().split(' ');
    
    if (!args || args.length < 2) {
      return ctx.reply(
        '📝 <b>Set Health Endpoint</b>\n\n' +
        'Usage: <code>/setendpoint &lt;app_name&gt; &lt;endpoint_url&gt;</code>\n\n' +
        'Examples:\n' +
        '• <code>/setendpoint myapp http://localhost:3001/health</code>\n' +
        '• <code>/setendpoint api http://localhost:8080/api/health</code>\n' +
        '• <code>/setendpoint worker http://localhost:3003/status</code>',
        { parse_mode: 'HTML' }
      );
    }

    const appName = args[0];
    const endpoint = args.slice(1).join(' ');

    // Validate URL format
    try {
      new URL(endpoint);
    } catch (error) {
      return ctx.reply(`❌ Invalid URL format: ${endpoint}`);
    }

    this.appHealthEndpoints.set(appName, endpoint);
    ctx.reply(`✅ Health endpoint set for <b>${appName}</b>:\n<code>${endpoint}</code>`, { parse_mode: 'HTML' });
  }

  async listHealthEndpoints(ctx) {
    const processes = await this.getPM2Processes();
    const onlineProcesses = processes.filter(p => 
      p && p.pm2_env && p.pm2_env.status === 'online' && p.name
    );

    if (onlineProcesses.length === 0) {
      return ctx.reply('📭 No online processes found.');
    }

    let message = '🔗 <b>Health Check Endpoints</b>\n\n';

    onlineProcesses.forEach(proc => {
      const processName = proc.name;
      const endpoint = this.getHealthEndpointForApp(processName);
      const isCustom = this.appHealthEndpoints.has(processName);
      
      message += `<b>${processName}</b>\n`;
      message += `   ${isCustom ? '🔧' : '⚙️'} <code>${endpoint}</code>\n`;
      message += `   ${isCustom ? 'Custom endpoint' : 'Default endpoint'}\n\n`;
    });

    message += '\n💡 Use <code>/setendpoint &lt;app&gt; &lt;url&gt;</code> to set custom endpoints';

    const keyboard = new InlineKeyboard()
      .text('🏥 Health Status', 'refresh_health')
      .text('📊 Process Status', 'refresh_status');

    ctx.reply(message, { 
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async handleCallbackQuery(ctx) {
    const data = ctx.callbackQuery.data;

    if (data === "refresh_status") {
      await this.getProcessStatus(ctx);
    } else if (data === "detailed_status") {
      await this.getDetailedStatus(ctx);
    } else if (data.startsWith("restart_")) {
      const processName = data.replace("restart_", "");
      try {
        await this.pm2Restart(processName);
        ctx.answerCallbackQuery(`✅ ${processName} restarted`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to restart ${processName}`);
      }
    } else if (data.startsWith("stop_")) {
      const processName = data.replace("stop_", "");
      try {
        await this.pm2Stop(processName);
        ctx.answerCallbackQuery(`✅ ${processName} stopped`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to stop ${processName}`);
      }
    } else if (data.startsWith("start_")) {
      const processName = data.replace("start_", "");
      try {
        await this.pm2Start(processName);
        ctx.answerCallbackQuery(`✅ ${processName} started`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to start ${processName}`);
      }
    } else if (data.startsWith("reload_")) {
      const processName = data.replace("reload_", "");
      try {
        await this.pm2Reload(processName);
        ctx.answerCallbackQuery(`✅ ${processName} reloaded`);
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery(`❌ Failed to reload ${processName}`);
      }
    } else if (data.startsWith("logs_")) {
      const processName = data.replace("logs_", "");

      // Show log options menu
      const keyboard = new InlineKeyboard()
        .text('📄 Recent (20 lines)', `viewlogs_${processName}_20`)
        .text('📄 More (50 lines)', `viewlogs_${processName}_50`)
        .row()
        .text('🔴 Error Logs', `errorlogs_${processName}`)
        .text('📊 Back to Status', 'refresh_status');

      ctx.reply(`📄 <b>Log Options for ${processName}</b>\n\nChoose what logs to view:`, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } else if (data.startsWith("viewlogs_")) {
      const parts = data.replace("viewlogs_", "").split("_");
      const processName = parts[0];
      const lines = parseInt(parts[1]) || 20;

      await this.showProcessLogs(ctx, processName, lines);
    } else if (data.startsWith("errorlogs_")) {
      const processName = data.replace("errorlogs_", "");
      await this.showProcessErrorLogs(ctx, processName);
    } else if (data === "restart_all") {
      try {
        await this.pm2RestartAll();
        ctx.answerCallbackQuery("✅ All processes restarted");
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery("❌ Failed to restart all processes");
      }
    } else if (data === "stop_all") {
      try {
        await this.pm2StopAll();
        ctx.answerCallbackQuery("✅ All processes stopped");
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery("❌ Failed to stop all processes");
      }
    } else if (data === 'refresh_health') {
      await this.getHealthStatus(ctx);
    }
  }
  async getDetailedStatus(ctx) {
    try {
      const processes = await this.getPM2Processes();

      if (processes.length === 0) {
        return ctx.reply("📭 No PM2 processes found.");
      }

      let message = "📊 <b>Detailed Process Status</b>\n\n";

      processes.forEach((proc) => {
        const env = proc.pm2_env;
        const status = env.status;
        const statusIcon =
          status === "online" ? "🟢" : status === "stopped" ? "🔴" : "🟡";

        message += `${statusIcon} <b>${proc.name}</b> (ID: ${proc.pm_id})\n`;
        message += `   Status: <code>${status}</code>\n`;
        message += `   PID: <code>${proc.pid || "N/A"}</code>\n`;
        message += `   CPU: <code>${proc.monit?.cpu || 0}%</code>\n`;
        message += `   Memory: <code>${proc.monit?.memory ? this.formatBytes(proc.monit.memory) : "0 MB"
          }</code>\n`;
        message += `   Uptime: <code>${env.pm_uptime ? this.formatUptime(Date.now() - env.pm_uptime) : "N/A"
          }</code>\n`;
        message += `   Restarts: <code>${env.restart_time || 0}</code>\n`;
        message += `   Script: <code>${env.pm_exec_path || "N/A"}</code>\n`;
        message += `   Mode: <code>${env.exec_mode || "N/A"}</code>\n\n`;
      });

      ctx.reply(message, { parse_mode: "HTML" });
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
        console.error("Monitoring error:", error);
      }
    }, this.monitorInterval);

    console.log(
      `🔍 Monitoring started with ${this.monitorInterval / 1000}s interval`
    );
  }

  async checkProcessHealth() {
    try {
      const processes = await this.getPM2Processes();
      const onlineProcesses = processes.filter(
        (p) => p.pm2_env.status === "online"
      );

      for (const proc of onlineProcesses) {
        const cpu = proc.monit?.cpu || 0;
        const memoryMB = proc.monit?.memory
          ? Math.round(proc.monit.memory / 1024 / 1024)
          : 0;
        const processName = proc.name;

        // Check for high CPU usage
        if (cpu > this.cpuThreshold) {
          await this.sendAlert(
            `🔴 High CPU Alert: ${processName} is using ${cpu}% CPU`
          );
        }

        // Check for high memory usage
        if (memoryMB > this.memoryThreshold) {
          await this.sendAlert(
            `🔴 High Memory Alert: ${processName} is using ${memoryMB}MB memory`
          );
        }

        // Check for stuck processes (not responding)
        if (await this.isProcessStuck(proc)) {
          await this.handleStuckProcess(proc);
        }
      }
    } catch (error) {
      console.error("Health check error:", error);
    }
  }

  async isProcessStuck(proc) {
    // Simple heuristic: if CPU is 0 for extended period and should be active
    const cpu = proc.monit?.cpu || 0;
    const uptime = Date.now() - proc.pm2_env.pm_uptime;

    // If process has been running for more than 5 minutes with 0% CPU consistently
    return uptime > 300000 && cpu === 0 && proc.pm2_env.status === "online";
  }

  async handleStuckProcess(proc) {
    const processName = proc.name;
    const currentCount = this.restartCounts.get(processName) || 0;

    if (currentCount < this.restartThreshold) {
      try {
        await this.pm2Restart(processName);
        this.restartCounts.set(processName, currentCount + 1);
        await this.sendAlert(
          `🔄 Auto-restarted stuck process: ${processName} (attempt ${currentCount + 1
          }/${this.restartThreshold})`
        );
      } catch (error) {
        await this.sendAlert(
          `❌ Failed to auto-restart ${processName}: ${error.message}`
        );
      }
    } else {
      await this.sendAlert(
        `⚠️ Process ${processName} has been restarted ${this.restartThreshold} times. Manual intervention required.`
      );
      // Reset counter after reaching threshold
      this.restartCounts.set(processName, 0);
    }
  }

  async sendAlert(message, isHealthAlert = false) {
    const alertMessage = `🚨 <b>PM2 Alert</b>\n\n${message}`;
    
    // Send to group chat if configured
    if (this.alertGroupChatId) {
      try {
        await this.bot.api.sendMessage(this.alertGroupChatId, alertMessage, {
          parse_mode: "HTML",
        });
      } catch (error) {
        console.error(`Failed to send alert to group chat ${this.alertGroupChatId}:`, error);
      }
    }
    
    // Send to individual authorized users (fallback or additional)
    for (const userId of this.authorizedUsers) {
      try {
        await this.bot.api.sendMessage(userId, alertMessage, {
          parse_mode: "HTML",
        });
      } catch (error) {
        console.error(`Failed to send alert to user ${userId}:`, error);
      }
    }
  }

  // Health Monitoring System
  startHealthMonitoring() {
    console.log(`🏥 Health monitoring started with ${this.healthCheckInterval / 1000}s interval`);
    
    setInterval(async () => {
      if (this.healthCheckRunning) return; // Prevent overlapping checks
      
      this.healthCheckRunning = true;
      try {
        await this.performHealthCheck();
      } catch (error) {
        console.error('Health check error:', error);
      } finally {
        this.healthCheckRunning = false;
      }
    }, this.healthCheckInterval);
  }

  async performHealthCheck() {
    try {
      const processes = await this.getPM2Processes();
      if (!processes || !Array.isArray(processes)) {
        console.warn('No valid processes array received from PM2');
        return;
      }

      if (processes.length === 0) {
        console.log('No PM2 processes found during health check');
        return;
      }

      const onlineProcesses = processes.filter(p => 
        p && 
        p.pm2_env && 
        p.pm2_env.status === 'online' && 
        p.name
      );

      console.log(`Health check: Found ${onlineProcesses.length} online processes out of ${processes.length} total`);

      for (const proc of onlineProcesses) {
        try {
          // Use HTTP health check if enabled, otherwise fall back to process monitoring
          if (this.httpHealthCheckEnabled) {
            await this.checkHttpHealth(proc);
          } else {
            await this.checkProcessHealth(proc);
          }
        } catch (error) {
          console.error(`Error checking health for process ${proc.name || 'unknown'}:`, error);
          // Continue with other processes even if one fails
        }
      }
    } catch (error) {
      console.error('Health check error:', error);
      // Don't crash the monitoring system, just log and continue
    }
  }

  async checkHttpHealth(proc) {
    console.log(`Proc`, proc)
    // Validate process object
    if (!proc || !proc.name) {
      console.warn('Invalid process object for HTTP health check:', proc?.name || 'unknown');
      return;
    }

    const processName = proc.name;
    const now = Date.now();

    // Get health endpoint for this app
    const healthEndpoint = this.getHealthEndpointForApp(processName);
    
    // Initialize health history if not exists
    if (!this.processHealthHistory.has(processName)) {
      this.processHealthHistory.set(processName, {
        lastHealthyTime: now,
        consecutiveUnhealthyChecks: 0,
        lastAlertTime: 0,
        lastHttpStatus: null,
        lastResponseTime: null
      });
    }

    const health = this.processHealthHistory.get(processName);
    let isHealthy = true;
    let healthIssues = [];

    try {
      // Perform HTTP health check
      const startTime = Date.now();
      const response = await axios.get(healthEndpoint, {
        timeout: this.healthCheckTimeout,
        validateStatus: (status) => status < 500 // Accept 2xx, 3xx, 4xx as "running"
      });
      
      const responseTime = Date.now() - startTime;
      health.lastHttpStatus = response.status;
      health.lastResponseTime = responseTime;

      // Check response status
      if (response.status >= 400) {
        isHealthy = false;
        healthIssues.push(`HTTP ${response.status} error`);
      }

      // Check response time
      if (responseTime > this.healthCheckTimeout * 0.8) {
        healthIssues.push(`Slow response (${responseTime}ms)`);
      }

      // Try to parse response for additional health info
      if (response.data && typeof response.data === 'object') {
        if (response.data.status === 'unhealthy' || response.data.healthy === false) {
          isHealthy = false;
          healthIssues.push('Application reports unhealthy status');
        }
      }

      console.log(`✅ Health check OK for ${processName}: ${response.status} (${responseTime}ms)`);

    } catch (error) {
      isHealthy = false;
      health.lastHttpStatus = error.response?.status || 'timeout';
      health.lastResponseTime = null;

      if (error.code === 'ECONNREFUSED') {
        healthIssues.push('Connection refused - service may be down');
      } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
        healthIssues.push('Request timeout - service not responding');
      } else if (error.response) {
        healthIssues.push(`HTTP ${error.response.status} error`);
      } else {
        healthIssues.push(`Network error: ${error.message}`);
      }

      console.log(`❌ Health check failed for ${processName}: ${error.message}`);
    }

    // Update health status
    if (isHealthy) {
      health.lastHealthyTime = now;
      health.consecutiveUnhealthyChecks = 0;
    } else {
      health.consecutiveUnhealthyChecks++;
      
      // Send alert and auto-restart if needed
      await this.handleUnhealthyProcess(processName, healthIssues, health);
    }

    this.processHealthHistory.set(processName, health);
  }

  getHealthEndpointForApp(appName) {
    // Check if app has custom endpoint
    if (this.appHealthEndpoints.has(appName)) {
      return this.appHealthEndpoints.get(appName);
    }

    // Try to get port from PM2 env vars or use default
    const port = this.getAppPort(appName) || this.healthCheckPort;
    return `http://localhost:${port}${this.defaultHealthEndpoint}`;
  }

  getAppPort(appName) {
    // This could be enhanced to read from PM2 process env or config
    // For now, we'll use some common port patterns
    const commonPorts = {
      'api': 3000,
      'web': 3001,
      'admin': 3002,
      'worker': 3003
    };

    // Check if app name contains port info
    const portMatch = appName.match(/(\d{4,5})/);
    if (portMatch) {
      return parseInt(portMatch[1]);
    }

    // Check common patterns
    for (const [pattern, port] of Object.entries(commonPorts)) {
      if (appName.toLowerCase().includes(pattern)) {
        return port;
      }
    }

    return null;
  }

  async checkProcessHealth(proc) {
    console.log('Proc', proc)
    // Validate process object
    if (!proc || !proc.name || !proc.pm2_env) {
      console.warn('Invalid process object received:', {
        hasProc: !!proc,
        hasName: !!(proc && proc.name),
        hasPm2Env: !!(proc && proc.pm2_env),
        procKeys: proc ? Object.keys(proc) : 'null'
      });
      return;
    }

    const processName = proc.name;
    const pid = proc.pid || 0;
    const cpu = proc.monit?.cpu || 0;
    const memoryBytes = proc.monit?.memory || 0;
    const memoryMB = Math.round(memoryBytes / 1024 / 1024);
    const uptime = proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : 0;
    const restarts = proc.pm2_env.restart_time || 0;

    // Initialize health history if not exists
    if (!this.processHealthHistory.has(processName)) {
      this.processHealthHistory.set(processName, {
        lastCpuValues: [],
        lastMemoryValues: [],
        lastRestartCount: restarts,
        lastHealthyTime: Date.now(),
        consecutiveUnhealthyChecks: 0,
        lastAlertTime: 0
      });
    }

    const health = this.processHealthHistory.get(processName);
    const now = Date.now();
    
    // Update history
    health.lastCpuValues.push({ value: cpu, timestamp: now });
    health.lastMemoryValues.push({ value: memoryMB, timestamp: now });
    
    // Keep only last 10 values (for trend analysis)
    if (health.lastCpuValues.length > 10) health.lastCpuValues.shift();
    if (health.lastMemoryValues.length > 10) health.lastMemoryValues.shift();

    let isHealthy = true;
    let healthIssues = [];

    // Check 1: Process stuck (very low CPU for extended period)
    if (await this.isProcessStuck(proc, health)) {
      isHealthy = false;
      healthIssues.push('Process appears stuck (very low CPU activity)');
    }

    // Check 2: Memory leak detection
    if (this.hasMemoryLeak(health, memoryMB)) {
      isHealthy = false;
      healthIssues.push(`Potential memory leak detected (${memoryMB}MB)`);
    }

    // Check 3: Frequent restarts
    if (this.hasFrequentRestarts(health, restarts)) {
      isHealthy = false;
      healthIssues.push(`Frequent restarts detected (${restarts} total)`);
    }

    // Check 4: Process responsiveness (using PM2 ping)
    if (await this.isProcessUnresponsive(processName)) {
      isHealthy = false;
      healthIssues.push('Process not responding to health checks');
    }

    // Update health status
    if (isHealthy) {
      health.lastHealthyTime = now;
      health.consecutiveUnhealthyChecks = 0;
    } else {
      health.consecutiveUnhealthyChecks++;
      
      // Send alert and auto-restart if needed
      await this.handleUnhealthyProcess(processName, healthIssues, health);
    }

    this.processHealthHistory.set(processName, health);
  }

  async isProcessStuck(proc, health) {
    if (!proc || !proc.pm2_env || !health) {
      return false;
    }

    const cpu = proc.monit?.cpu || 0;
    const uptime = proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : 0;
    
    // Process must be running for at least the stuck threshold time
    if (uptime < this.stuckProcessThreshold) return false;
    
    // Check if CPU has been consistently very low
    const recentCpuValues = health.lastCpuValues.slice(-5); // Last 5 checks
    if (recentCpuValues.length < 5) return false;
    
    const avgCpu = recentCpuValues.reduce((sum, item) => sum + item.value, 0) / recentCpuValues.length;
    return avgCpu < this.cpuStuckThreshold;
  }

  hasMemoryLeak(health, currentMemoryMB) {
    if (currentMemoryMB > this.memoryLeakThreshold) {
      // Check if memory is consistently increasing
      const recentMemory = health.lastMemoryValues.slice(-5);
      if (recentMemory.length < 5) return false;
      
      let increasingTrend = 0;
      for (let i = 1; i < recentMemory.length; i++) {
        if (recentMemory[i].value > recentMemory[i-1].value) {
          increasingTrend++;
        }
      }
      
      return increasingTrend >= 3; // 3 out of 4 increases
    }
    return false;
  }

  hasFrequentRestarts(health, currentRestarts) {
    if (currentRestarts > health.lastRestartCount) {
      const restartIncrease = currentRestarts - health.lastRestartCount;
      health.lastRestartCount = currentRestarts;
      
      // More than 3 restarts in recent history is concerning
      return restartIncrease > 3;
    }
    return false;
  }

  async isProcessUnresponsive(processName) {
    return new Promise((resolve) => {
      // Use pm2 ping to check if process is responsive
      const command = `pm2 ping ${processName}`;
      
      exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
        if (error || stderr) {
          resolve(true); // Unresponsive
        } else {
          resolve(false); // Responsive
        }
      });
    });
  }

  async handleUnhealthyProcess(processName, healthIssues, health) {
    const now = Date.now();
    const alertCooldown = 300000; // 5 minutes between alerts for same process
    
    // Check if we should send an alert (cooldown)
    const lastAlert = health.lastAlertTime || 0;
    const shouldAlert = (now - lastAlert) > alertCooldown;
    
    if (shouldAlert) {
      const issueText = healthIssues.join(', ');
      await this.sendAlert(
        `⚠️ <b>Health Check Alert</b>\n\n` +
        `Process: <code>${processName}</code>\n` +
        `Issues: ${issueText}\n` +
        `Consecutive unhealthy checks: ${health.consecutiveUnhealthyChecks}\n\n` +
        `${health.consecutiveUnhealthyChecks >= 3 ? '🔄 Attempting auto-restart...' : ''}`,
        true
      );
      
      health.lastAlertTime = now;
    }
    
    // Auto-restart if process has been unhealthy for 3+ consecutive checks
    if (health.consecutiveUnhealthyChecks >= 3) {
      const currentRestartCount = this.restartCounts.get(processName) || 0;
      
      if (currentRestartCount < this.restartThreshold) {
        try {
          await this.pm2Restart(processName);
          this.restartCounts.set(processName, currentRestartCount + 1);
          
          await this.sendAlert(
            `🔄 <b>Auto-Restart Performed</b>\n\n` +
            `Process: <code>${processName}</code>\n` +
            `Reason: Health check failure\n` +
            `Attempt: ${currentRestartCount + 1}/${this.restartThreshold}`,
            true
          );
          
          // Reset health status after restart
          health.consecutiveUnhealthyChecks = 0;
          health.lastHealthyTime = now;
          
        } catch (error) {
          await this.sendAlert(
            `❌ <b>Auto-Restart Failed</b>\n\n` +
            `Process: <code>${processName}</code>\n` +
            `Error: ${error.message}`,
            true
          );
        }
      } else {
        await this.sendAlert(
          `🚨 <b>Critical Alert</b>\n\n` +
          `Process: <code>${processName}</code>\n` +
          `Status: Exceeded restart threshold (${this.restartThreshold})\n` +
          `Action Required: Manual intervention needed`,
          true
        );
        
        // Reset restart count after reaching threshold
        this.restartCounts.set(processName, 0);
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

        pm2.restart("all", (err) => {
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

        pm2.stop("all", (err) => {
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

        pm2.start("all", (err) => {
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

  async getPM2Logs(processName, lines = 20) {
    return new Promise((resolve, reject) => {
      // Use pm2 logs command with --lines to limit output and avoid overflow
      const command = `pm2 logs ${processName} --lines ${lines} --nostream`;

      exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error getting logs for ${processName}:`, error);
          return reject(new Error(`Failed to get logs: ${error.message}`));
        }

        if (stderr) {
          console.warn(`PM2 logs stderr for ${processName}:`, stderr);
        }

        // Parse the output and return as array of lines
        const lines = stdout.trim().split('\n').filter(line => line.trim() !== '');

        // If no logs found, return empty array
        if (lines.length === 0 || stdout.includes('No logs found')) {
          return resolve([]);
        }

        // Clean up the log lines and remove PM2 formatting if needed
        const cleanedLines = lines.map(line => {
          // Remove ANSI color codes and clean up formatting
          return line
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s*/, '') // Remove timestamp prefix if present
            .trim();
        }).filter(line => line.length > 0);

        resolve(cleanedLines);
      });
    });
  }

  async getPM2ErrorLogs(processName, lines = 10) {
    return new Promise((resolve, reject) => {
      // Get error logs specifically
      const command = `pm2 logs ${processName} --err --lines ${lines} --nostream`;

      exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error getting error logs for ${processName}:`, error);
          return reject(new Error(`Failed to get error logs: ${error.message}`));
        }

        // Parse and clean the output
        const lines = stdout.trim().split('\n').filter(line => line.trim() !== '');

        if (lines.length === 0) {
          return resolve([]);
        }

        const cleanedLines = lines.map(line => {
          return line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        }).filter(line => line.length > 0);

        resolve(cleanedLines);
      });
    });
  }

  // Utility methods
  formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
        console.log(
          `📊 Monitoring ${this.authorizedUsers.length} authorized users`
        );
        console.log(
          `⚙️ CPU threshold: ${this.cpuThreshold}%, Memory threshold: ${this.memoryThreshold}MB`
        );
      },
    });
  }
}

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Start the bot
const bot = new PM2TelegramBot();
bot.start();
