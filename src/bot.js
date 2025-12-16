require("dotenv").config();

const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs-extra");
const path = require("path");

const execAsync = promisify(exec);

class PM2TelegramBot {
  constructor() {
    this.bot = new Bot(process.env.BOT_TOKEN);
    this.authorizedUsers =
      process.env.AUTHORIZED_USERS?.split(",").map((id) => parseInt(id)) || [];
    this.authorizedChatsForAlert =
      process.env.AUTHORIZED_CHATS_FOR_ALERT?.split(",").map((id) => parseInt(id)) || [];
    this.monitorInterval = parseInt(process.env.MONITOR_INTERVAL) || 30000;
    this.cpuThreshold = parseInt(process.env.CPU_THRESHOLD) || 90;
    this.memoryThreshold = parseInt(process.env.MEMORY_THRESHOLD) || 512;

    // Audit logging configuration
    this.auditLoggingEnabled = process.env.AUDIT_LOGGING_ENABLED === 'true';
    this.auditLogFile = process.env.AUDIT_LOG_FILE || 'logs/bot-audit.log';
    this.auditLogMaxSize = parseInt(process.env.AUDIT_LOG_MAX_SIZE) || 10485760; // 10MB
    this.auditLogMaxFiles = parseInt(process.env.AUDIT_LOG_MAX_FILES) || 5;
    this.auditLogMaxLines = parseInt(process.env.AUDIT_LOG_MAX_LINES) || 10000;
    this.auditLogCurrentLines = 0;

    // PM2 CLI command timeout (prevent hanging commands)
    this.commandTimeout = parseInt(process.env.PM2_COMMAND_TIMEOUT) || 30000; // 30 seconds

    // Initialize audit logging
    if (this.auditLoggingEnabled) {
      this.initializeAuditLogging();
    }

    this.setupCommands();
    this.setupMiddleware();
    this.startMonitoring();
  }

  // Audit Logging System
  async initializeAuditLogging() {
    try {
      // Ensure logs directory exists
      const logDir = path.dirname(this.auditLogFile);
      await fs.ensureDir(logDir);

      // Count existing lines if file exists
      if (await fs.pathExists(this.auditLogFile)) {
        const content = await fs.readFile(this.auditLogFile, 'utf8');
        this.auditLogCurrentLines = content.split('\n').length - 1;
      }

      console.log(`📝 Audit logging initialized: ${this.auditLogFile}`);
      await this.logAudit('SYSTEM', 'Bot started', { timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Failed to initialize audit logging:', error);
    }
  }

  async logAudit(action, description, metadata = {}) {
    return this.logAuditWithCtx(action, description, metadata, null);
  }

  async logAuditWithCtx(action, description, metadata = {}, ctx = null) {
    if (!this.auditLoggingEnabled) return;

    try {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        action,
        description,
        metadata: {
          ...metadata,
          // Add chat ID if ctx is provided
          ...(ctx && ctx.chat?.id && {
            from_chat_id: ctx.chat.id
          })
        }
      };

      const logLine = JSON.stringify(logEntry) + '\n';

      // Check if rotation is needed
      await this.checkLogRotation();

      // Append to log file
      await fs.appendFile(this.auditLogFile, logLine);
      this.auditLogCurrentLines++;

      const chatStr = ctx?.chat?.id ? ` from chat ${ctx.chat.id}` : '';
      console.log(`📝 Audit: ${action} - ${description}${chatStr}`);
    } catch (error) {
      console.error('Failed to write audit log:', error);
    }
  }

  async checkLogRotation() {
    try {
      if (!await fs.pathExists(this.auditLogFile)) return;

      const stats = await fs.stat(this.auditLogFile);
      const shouldRotateBySize = stats.size >= this.auditLogMaxSize;
      const shouldRotateByLines = this.auditLogCurrentLines >= this.auditLogMaxLines;

      if (shouldRotateBySize || shouldRotateByLines) {
        await this.rotateLogFile();
      }
    } catch (error) {
      console.error('Failed to check log rotation:', error);
    }
  }

  async rotateLogFile() {
    try {
      const logDir = path.dirname(this.auditLogFile);
      const logName = path.basename(this.auditLogFile, path.extname(this.auditLogFile));
      const logExt = path.extname(this.auditLogFile);

      // Rotate existing files
      for (let i = this.auditLogMaxFiles - 1; i >= 1; i--) {
        const oldFile = path.join(logDir, `${logName}.${i}${logExt}`);
        const newFile = path.join(logDir, `${logName}.${i + 1}${logExt}`);

        if (await fs.pathExists(oldFile)) {
          if (i === this.auditLogMaxFiles - 1) {
            // Delete the oldest file
            await fs.remove(oldFile);
          } else {
            await fs.move(oldFile, newFile);
          }
        }
      }

      // Move current log to .1
      const rotatedFile = path.join(logDir, `${logName}.1${logExt}`);
      await fs.move(this.auditLogFile, rotatedFile);

      // Reset line counter
      this.auditLogCurrentLines = 0;

      console.log(`📝 Log rotated: ${this.auditLogFile} -> ${rotatedFile}`);
      await this.logAudit('SYSTEM', 'Log file rotated', {
        rotatedTo: rotatedFile,
        maxSize: this.auditLogMaxSize,
        maxLines: this.auditLogMaxLines
      });
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  setupMiddleware() {
    // Audit logging middleware
    if (this.auditLoggingEnabled) {
      this.bot.use(async (ctx, next) => {
        const message = ctx.message;

        // Log the incoming request
        await this.logAuditWithCtx('REQUEST', 'Incoming message', {
          messageType: message?.text ? 'text' : 'other',
          command: message?.text?.startsWith('/') ? message.text.split(' ')[0] : null,
          messageText: message?.text?.substring(0, 100) // Truncate long messages
        }, ctx);

        return next();
      });
    }

    // Authorization middleware
    this.bot.use((ctx, next) => {
      if (
        this.authorizedUsers.length === 0 ||
        this.authorizedUsers.includes(ctx.from?.id) ||
        this.authorizedUsers.includes(ctx.from?.username)
      ) {
        return next();
      }

      // Log unauthorized access attempt
      if (this.auditLoggingEnabled) {
        this.logAuditWithCtx('SECURITY', 'Unauthorized access attempt', {
          userId: ctx.from?.id,
          username: ctx.from?.username,
          messageText: ctx.message?.text
        }, ctx);
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
        .text("📈 Monitor")
        .row()
        .text("🔄 Restart All")
        .text("⏹️ Stop All")
        .row()
        .text("▶️ Start All")
        .text("⚙️ Settings")
        .resized();

      ctx.reply(
        "🤖 <b>PM2 Management Bot</b>\n\n" +
        "Welcome! I can help you manage your PM2 processes.\n\n" +
        "Available commands:\n" +
        "• <code>/status</code> - Show process status\n" +
        "• <code>/monitor</code> - Show monitoring info\n" +
        "• <code>/restartall</code> - Restart all processes\n" +
        "• <code>/stopall</code> - Stop all processes\n" +
        "• <code>/startall</code> - Start all processes\n" +
        "• <code>/auditlogs [lines]</code> - View audit logs\n" +
        "• <code>/clearaudit</code> - Clear audit logs\n" +
        "• <code>/help</code> - Show this help\n\n" +
        "⚠️ <b>Security Notice:</b> Only essential bulk operations are available to prevent accidental process management.",
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

    // Restart all command
    this.bot.command("restartall", (ctx) => this.restartAllProcesses(ctx));
    this.bot.hears("🔄 Restart All", (ctx) => this.restartAllProcesses(ctx));

    // Stop all command
    this.bot.command("stopall", (ctx) => this.stopAllProcesses(ctx));
    this.bot.hears("⏹️ Stop All", (ctx) => this.stopAllProcesses(ctx));

    // Start all command
    this.bot.command("startall", (ctx) => this.startAllProcesses(ctx));
    this.bot.hears("▶️ Start All", (ctx) => this.startAllProcesses(ctx));

    // Monitor command
    this.bot.command("monitor", (ctx) => this.getMonitoringStatus(ctx));
    this.bot.hears("📈 Monitor", (ctx) => this.getMonitoringStatus(ctx));

    // Settings
    this.bot.hears("⚙️ Settings", (ctx) => this.showSettings(ctx));

    // Audit logging commands
    this.bot.command("auditlogs", (ctx) => this.getAuditLogs(ctx));
    this.bot.command("clearaudit", (ctx) => this.clearAuditLogs(ctx));

    // Callback query handlers
    this.bot.on("callback_query", (ctx) => this.handleCallbackQuery(ctx));
  }

  async getProcessStatus(ctx) {
    try {
      const processes = await this.getPM2ProcessesCLI();

      if (processes.length === 0) {
        return ctx.reply("📭 No PM2 processes found.");
      }

      // Summary stats
      const stats = this.getProcessStats(processes);
      let message = `📊 <b>PM2 Status</b>\n\n`;
      message += `📈 <b>Summary:</b> ${stats.online}🟢 ${stats.stopped}🔴 ${stats.errored}🟡 | Total: ${processes.length}\n\n`;

      // Process list (compact format)
      processes.forEach((proc) => {
        const status = proc.status;
        const statusIcon = status === "online" ? "🟢" : status === "stopped" ? "🔴" : "🟡";
        const cpu = proc.cpu || 0;
        const memory = proc.memory || 0;
        const restarts = proc.restarts || 0;

        message += `${statusIcon} <b>${proc.name}</b>\n`;
        if (status === 'online') {
          message += `   💻 ${cpu}% CPU | 💾 ${memory}MB | 🔄 ${restarts}x\n`;
        } else {
          message += `   Status: <code>${status}</code> | Restarts: <code>${restarts}</code>\n`;
        }
        message += '\n';
      });

      // Create action keyboard
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', 'refresh_status')
        .text('📈 Monitor', 'monitor_status')
        .row()
        .text('🔄 Restart All', 'restart_all')
        .text('⏹️ Stop All', 'stop_all')
        .text('▶️ Start All', 'start_all');

      ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (error) {
      await this.logAuditWithCtx('ERROR', 'Failed to get process status', { error: error.message }, ctx);
      ctx.reply(`❌ Error getting process status: ${error.message}`);
    }
  }

  getProcessStats(processes) {
    return {
      online: processes.filter(p => p.status === 'online').length,
      stopped: processes.filter(p => p.status === 'stopped').length,
      errored: processes.filter(p => p.status === 'errored').length
    };
  }

  async restartAllProcesses(ctx) {
    try {
      // Add confirmation for safety
      const keyboard = new InlineKeyboard()
        .text('✅ Confirm Restart All', 'confirm_restart_all')
        .text('❌ Cancel', 'cancel_action');

      ctx.reply(
        "⚠️ <b>Confirm Action</b>\n\n" +
        "Are you sure you want to restart ALL PM2 processes?\n" +
        "This will temporarily interrupt all running applications.",
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    } catch (error) {
      await this.logAuditWithCtx('ERROR', 'Failed to show restart all confirmation', { error: error.message }, ctx);
      ctx.reply(`❌ Error: ${error.message}`);
    }
  }

  async stopAllProcesses(ctx) {
    try {
      // Add confirmation for safety
      const keyboard = new InlineKeyboard()
        .text('✅ Confirm Stop All', 'confirm_stop_all')
        .text('❌ Cancel', 'cancel_action');

      ctx.reply(
        "⚠️ <b>Confirm Action</b>\n\n" +
        "Are you sure you want to stop ALL PM2 processes?\n" +
        "This will shut down all running applications.",
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    } catch (error) {
      await this.logAuditWithCtx('ERROR', 'Failed to show stop all confirmation', { error: error.message }, ctx);
      ctx.reply(`❌ Error: ${error.message}`);
    }
  }

  async startAllProcesses(ctx) {
    try {
      // Add confirmation for safety
      const keyboard = new InlineKeyboard()
        .text('✅ Confirm Start All', 'confirm_start_all')
        .text('❌ Cancel', 'cancel_action');

      ctx.reply(
        "⚠️ <b>Confirm Action</b>\n\n" +
        "Are you sure you want to start ALL PM2 processes?\n" +
        "This will attempt to start all configured applications.",
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }
      );
    } catch (error) {
      await this.logAuditWithCtx('ERROR', 'Failed to show start all confirmation', { error: error.message }, ctx);
      ctx.reply(`❌ Error: ${error.message}`);
    }
  }

  async getMonitoringStatus(ctx) {
    try {
      const processes = await this.getPM2ProcessesCLI();
      const onlineProcesses = processes.filter(
        (p) => p.status === "online"
      );

      if (onlineProcesses.length === 0) {
        return ctx.reply("📈 No online processes to monitor.");
      }

      let message = "📈 <b>Process Monitoring</b>\n\n";

      onlineProcesses.forEach((proc) => {
        const cpu = proc.cpu || 0;
        const memory = proc.memory || 0;
        const cpuStatus =
          cpu > this.cpuThreshold ? "🔴" : cpu > 50 ? "🟡" : "🟢";
        const memoryStatus =
          memory > this.memoryThreshold ? "🔴" : memory > 50 ? "🟡" : "🟢";

        message += `<b>${proc.name}</b>\n`;
        message += `   CPU: ${cpuStatus} <code>${cpu}%</code>\n`;
        message += `   Memory: ${memoryStatus} <code>${memory}MB</code>\n`;
        message += `   PID: <code>${proc.pid || 'N/A'}</code>\n\n`;
      });

      message += `\n⚙️ <b>Thresholds:</b>\n`;
      message += `CPU: <code>${this.cpuThreshold}%</code> | Memory: <code>${this.memoryThreshold}MB</code>`;

      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', 'monitor_status')
        .text('📊 Status', 'refresh_status');

      ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    } catch (error) {
      await this.logAuditWithCtx('ERROR', 'Failed to get monitoring status', { error: error.message }, ctx);
      ctx.reply(`❌ Error getting monitoring status: ${error.message}`);
    }
  }

  async showSettings(ctx) {
    const message =
      `⚙️ <b>Bot Settings</b>\n\n` +
      `Monitor Interval: <code>${this.monitorInterval / 1000}s</code>\n` +
      `CPU Threshold: <code>${this.cpuThreshold}%</code>\n` +
      `Memory Threshold: <code>${this.memoryThreshold}MB</code>\n\n` +
      `Audit Logging: <code>${this.auditLoggingEnabled ? 'Enabled' : 'Disabled'}</code>\n` +
      `Log File: <code>${this.auditLogFile}</code>\n` +
      `Current Lines: <code>${this.auditLogCurrentLines}</code>\n` +
      `Max Lines: <code>${this.auditLogMaxLines}</code>\n` +
      `Max Size: <code>${Math.round(this.auditLogMaxSize / 1024 / 1024)}MB</code>\n\n` +
      `Authorized Users: <code>${this.authorizedUsers.length}</code>`;

    ctx.reply(message, { parse_mode: "HTML" });
  }

  async getAuditLogs(ctx) {
    if (!this.auditLoggingEnabled) {
      return ctx.reply('📝 Audit logging is disabled. Enable it in environment settings.');
    }

    try {
      const args = ctx.match?.trim().split(' ') || [];
      const lines = parseInt(args[0]) || 20;

      if (!await fs.pathExists(this.auditLogFile)) {
        return ctx.reply('📝 No audit log file found.');
      }

      const content = await fs.readFile(this.auditLogFile, 'utf8');
      const logLines = content.trim().split('\n').filter(line => line.trim());

      if (logLines.length === 0) {
        return ctx.reply('📝 Audit log is empty.');
      }

      // Get recent logs
      const recentLogs = logLines.slice(-lines);
      let message = `📝 <b>Audit Logs</b> (last ${recentLogs.length} entries)\n\n`;

      recentLogs.forEach(line => {
        try {
          const entry = JSON.parse(line);
          const time = new Date(entry.timestamp).toLocaleString();
          message += `🕐 <code>${time}</code>\n`;
          message += `📋 <b>${entry.action}</b>: ${entry.description}\n`;

          // Show who executed the action
          if (entry.metadata?.executedBy) {
            const user = entry.metadata.executedBy;
            const userStr = user.username || user.firstName || `ID:${user.userId}`;
            message += `� <b>By:$</b> <code>${userStr}</code>\n`;
          } else if (entry.action.includes('AUTO') || entry.action === 'SYSTEM') {
            message += `🤖 <b>By:</b> <code>System</code>\n`;
          }

          if (entry.metadata && Object.keys(entry.metadata).length > 0) {
            // Filter out executedBy from metadata display since we show it separately
            const filteredMeta = Object.entries(entry.metadata)
              .filter(([key]) => key !== 'from_chat_id')
              .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
              .join(', ');

            if (filteredMeta) {
              message += `📊 <code>${filteredMeta}</code>\n`;
            }
          }
          message += '\n';
        } catch (error) {
          // Skip malformed log entries
        }
      });

      // Split message if too long
      if (message.length > 4000) {
        const parts = this.splitMessage(message, 4000);
        for (const part of parts) {
          await ctx.reply(part, { parse_mode: 'HTML' });
        }
      } else {
        const keyboard = new InlineKeyboard()
          .text('🔄 Refresh', 'audit_refresh')
          .text('🗑️ Clear Logs', 'audit_clear');

        ctx.reply(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
      }

      await this.logAudit('AUDIT_VIEW', `Viewed audit logs (${lines} entries)`, { requestedLines: lines });

    } catch (error) {
      ctx.reply(`❌ Error reading audit logs: ${error.message}`);
    }
  }

  async clearAuditLogs(ctx) {
    if (!this.auditLoggingEnabled) {
      return ctx.reply('📝 Audit logging is disabled.');
    }

    try {
      if (await fs.pathExists(this.auditLogFile)) {
        // Backup current log before clearing
        const backupFile = `${this.auditLogFile}.backup.${Date.now()}`;
        await fs.copy(this.auditLogFile, backupFile);

        // Clear the log file
        await fs.writeFile(this.auditLogFile, '');
        this.auditLogCurrentLines = 0;

        await this.logAudit('AUDIT_CLEAR', 'Audit logs cleared', { backupFile });
        ctx.reply(`✅ Audit logs cleared. Backup saved to: <code>${backupFile}</code>`, { parse_mode: 'HTML' });
      } else {
        ctx.reply('📝 No audit log file to clear.');
      }
    } catch (error) {
      ctx.reply(`❌ Error clearing audit logs: ${error.message}`);
    }
  }

  splitMessage(message, maxLength) {
    const parts = [];
    let currentPart = '';
    const lines = message.split('\n');

    for (const line of lines) {
      if ((currentPart + line + '\n').length > maxLength) {
        if (currentPart) {
          parts.push(currentPart);
          currentPart = '';
        }
      }
      currentPart += line + '\n';
    }

    if (currentPart) {
      parts.push(currentPart);
    }

    return parts;
  }

  async handleCallbackQuery(ctx) {
    const data = ctx.callbackQuery.data;

    if (data === "refresh_status") {
      await this.getProcessStatus(ctx);
    } else if (data === "monitor_status") {
      await this.getMonitoringStatus(ctx);
    } else if (data === "restart_all") {
      await this.restartAllProcesses(ctx);
    } else if (data === "stop_all") {
      await this.stopAllProcesses(ctx);
    } else if (data === "start_all") {
      await this.startAllProcesses(ctx);
    } else if (data === "confirm_restart_all") {
      try {
        await this.pm2RestartAllCLI(ctx);
        ctx.answerCallbackQuery("✅ All processes restarted");
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery("❌ Failed to restart all processes");
      }
    } else if (data === "confirm_stop_all") {
      try {
        await this.pm2StopAllCLI(ctx);
        ctx.answerCallbackQuery("✅ All processes stopped");
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery("❌ Failed to stop all processes");
      }
    } else if (data === "confirm_start_all") {
      try {
        await this.pm2StartAllCLI(ctx);
        ctx.answerCallbackQuery("✅ All processes started");
        await this.getProcessStatus(ctx);
      } catch (error) {
        ctx.answerCallbackQuery("❌ Failed to start all processes");
      }
    } else if (data === "cancel_action") {
      ctx.answerCallbackQuery("❌ Action cancelled");
      await this.getProcessStatus(ctx);
    } else if (data === 'audit_refresh') {
      await this.getAuditLogs(ctx);
    } else if (data === 'audit_clear') {
      await this.clearAuditLogs(ctx);
    } else {
      ctx.answerCallbackQuery();
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
      const processes = await this.getPM2ProcessesCLI();
      const onlineProcesses = processes.filter(
        (p) => p.status === "online"
      );

      for (const proc of onlineProcesses) {
        const cpu = proc.cpu || 0;
        const memory = proc.memory || 0;
        const processName = proc.name;

        // Check for high CPU usage
        if (cpu > this.cpuThreshold) {
          await this.sendAlert(
            `🔴 High CPU Alert: ${processName} is using ${cpu}% CPU`
          );
        }

        // Check for high memory usage
        if (memory > this.memoryThreshold) {
          await this.sendAlert(
            `🔴 High Memory Alert: ${processName} is using ${memory}MB memory`
          );
        }
      }
    } catch (error) {
      console.error("Health check error:", error);
    }
  }

  async sendAlert(message) {
    // Send alert to all authorized users
    for (const chatId of this.authorizedChatsForAlert) {
      try {
        await this.bot.api.sendMessage(
          chatId,
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

  // Secure PM2 CLI methods
  async getPM2ProcessesCLI() {
    try {
      const { stdout } = await execAsync('pm2 jlist', { timeout: this.commandTimeout });

      // Handle empty or invalid JSON response
      if (!stdout || stdout.trim() === '' || stdout.trim() === '[]') {
        return [];
      }

      let processes;
      try {
        processes = JSON.parse(stdout);
      } catch (parseError) {
        console.error('Failed to parse PM2 JSON output:', parseError);
        console.error('Raw output:', stdout);
        throw new Error('Failed to parse PM2 process list - PM2 may not be running or configured properly');
      }

      // Ensure processes is an array
      if (!Array.isArray(processes)) {
        console.error('PM2 output is not an array:', processes);
        return [];
      }

      // Transform to simplified format
      return processes.map(proc => ({
        name: proc.name || 'unknown',
        pid: proc.pid || null,
        status: proc.pm2_env?.status || 'unknown',
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory ? Math.round(proc.monit.memory / 1024 / 1024) : 0,
        restarts: proc.pm2_env?.restart_time || 0,
        uptime: proc.pm2_env?.pm_uptime || null
      }));
    } catch (error) {
      console.error('Failed to get PM2 processes:', error);
      throw new Error(`Failed to get process list: ${error.message}`);
    }
  }

  async pm2RestartAllCLI(ctx = null) {
    await this.logAuditWithCtx('PM2_RESTART_ALL', 'Restarting all processes via CLI', {}, ctx);

    try {
      const { stdout, stderr } = await execAsync('pm2 restart all', { timeout: this.commandTimeout });

      if (stderr && !stderr.includes('PM2')) {
        throw new Error(stderr);
      }

      await this.logAuditWithCtx('PM2_SUCCESS', 'Successfully restarted all processes', { output: stdout.substring(0, 200) }, ctx);
      return stdout;
    } catch (error) {
      await this.logAuditWithCtx('PM2_ERROR', 'Failed to restart all processes', { error: error.message }, ctx);
      throw new Error(`Failed to restart all processes: ${error.message}`);
    }
  }

  async pm2StopAllCLI(ctx = null) {
    await this.logAuditWithCtx('PM2_STOP_ALL', 'Stopping all processes via CLI', {}, ctx);

    try {
      const { stdout, stderr } = await execAsync('pm2 stop all', { timeout: this.commandTimeout });

      if (stderr && !stderr.includes('PM2')) {
        throw new Error(stderr);
      }

      await this.logAuditWithCtx('PM2_SUCCESS', 'Successfully stopped all processes', { output: stdout.substring(0, 200) }, ctx);
      return stdout;
    } catch (error) {
      await this.logAuditWithCtx('PM2_ERROR', 'Failed to stop all processes', { error: error.message }, ctx);
      throw new Error(`Failed to stop all processes: ${error.message}`);
    }
  }

  async pm2StartAllCLI(ctx = null) {
    await this.logAuditWithCtx('PM2_START_ALL', 'Starting all processes via CLI', {}, ctx);

    try {
      const { stdout, stderr } = await execAsync('pm2 start all', { timeout: this.commandTimeout });

      if (stderr && !stderr.includes('PM2')) {
        throw new Error(stderr);
      }

      await this.logAuditWithCtx('PM2_SUCCESS', 'Successfully started all processes', { output: stdout.substring(0, 200) }, ctx);
      return stdout;
    } catch (error) {
      await this.logAuditWithCtx('PM2_ERROR', 'Failed to start all processes', { error: error.message }, ctx);
      throw new Error(`Failed to start all processes: ${error.message}`);
    }
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

  async gracefulShutdown() {
    console.log('🔄 Gracefully shutting down bot...');

    if (this.auditLoggingEnabled) {
      await this.logAudit('SYSTEM', 'Bot shutting down gracefully');
    }

    console.log('✅ Bot shutdown complete');
  }

  start() {
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      await this.gracefulShutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      await this.gracefulShutdown();
      process.exit(0);
    });

    this.bot.start({
      onStart: (botInfo) => {
        console.log(`🤖 Bot @${botInfo.username} started successfully.`);
        console.log(
          `📊 Monitoring ${this.authorizedUsers.length} authorized users`
        );
        console.log(
          `📢 Alerting ${this.authorizedChatsForAlert.length} authorized chats`
        );
        console.log(
          `⚙️ CPU threshold: ${this.cpuThreshold}%, Memory threshold: ${this.memoryThreshold}MB`
        );
        console.log(`🔒 PM2 CLI: Secure command execution enabled`);
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
