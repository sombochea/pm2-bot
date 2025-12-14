require("dotenv").config();

const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const pm2 = require("pm2");
const cron = require("node-cron");
const { exec } = require("child_process");

class PM2TelegramBot {
  constructor() {
    this.bot = new Bot(process.env.BOT_TOKEN);
    this.authorizedUsers =
      process.env.AUTHORIZED_USERS?.split(",").map((id) => parseInt(id)) || [];
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
      `Authorized Users: <code>${this.authorizedUsers.length}</code>`;

    ctx.reply(message, { parse_mode: "HTML" });
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

  async sendAlert(message) {
    // Send alert to all authorized users
    for (const userId of this.authorizedUsers) {
      try {
        await this.bot.api.sendMessage(
          userId,
          `🚨 <b>PM2 Alert</b>\n\n${message}`,
          {
            parse_mode: "HTML",
          }
        );
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
