module.exports = {
  apps: [{
    name: 'pm2-telegram-bot',
    script: './src/bot.js',
    instances: 1,
    exec_mode: 'fork',
    
    // Environment variables
    env: {
      NODE_ENV: 'production',
      // IMPORTANT: Set this to match the PM2 process name
      PM2_PROCESS_NAME: 'pm2-telegram-bot',
      // Self-protection: prevent bot from managing itself
      EXCLUDE_SELF_FROM_OPERATIONS: 'true'
    },
    
    // Restart behavior - CRITICAL to prevent infinite loops
    autorestart: true,
    max_restarts: 10,              // Limit restarts to prevent infinite loops
    min_uptime: '10s',             // Minimum uptime before considering successful
    max_memory_restart: '500M',     // Restart if memory exceeds this
    
    // Exponential backoff for restarts
    restart_delay: 4000,            // Wait 4s before restarting
    exp_backoff_restart_delay: 100, // Exponential backoff
    
    // Error handling
    error_file: './logs/pm2-bot-error.log',
    out_file: './logs/pm2-bot-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Watch and reload (disable to prevent unnecessary restarts)
    watch: false,
    ignore_watch: ['node_modules', 'logs', '.git'],
    
    // Advanced features
    kill_timeout: 5000,             // Time to wait for graceful shutdown
    listen_timeout: 10000,          // Time to wait for app to be ready
    shutdown_with_message: false    // Don't restart on message
  }]
};
