module.exports = {
    apps: [{
        name: 'robo-unimed',
        script: './robo_unimed_debian.js',
        cwd: '/opt/robo-unimed',
        watch: false,
        autorestart: true,
        max_restarts: 10,
        restart_delay: 10000,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'production',
            TZ: 'America/Sao_Paulo'
        },
        log_date_format: 'DD/MM/YYYY HH:mm:ss',
        error_file: '/opt/robo-unimed/logs/error.log',
        out_file: '/opt/robo-unimed/logs/output.log',
        merge_logs: true,
        log_file: '/opt/robo-unimed/logs/combined.log'
    }]
};
