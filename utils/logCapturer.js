const logBuffer = [];
const MAX_LOGS = 1000;

const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

function formatMessage(args) {
    return args.map(arg => {
        if (arg instanceof Error) {
            return arg.stack || arg.message;
        }
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg);
            } catch (e) {
                return '[Circular Object]';
            }
        }
        return String(arg);
    }).join(' ');
}

function addLog(level, message) {
    logBuffer.push({
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        level,
        message,
        stream: 'stdout'
    });
    if (logBuffer.length > MAX_LOGS) {
        logBuffer.shift();
    }
}

console.log = (...args) => {
    originalLog(...args);
    addLog('INFO', formatMessage(args));
};

console.info = (...args) => {
    originalInfo(...args);
    addLog('INFO', formatMessage(args));
};

console.warn = (...args) => {
    originalWarn(...args);
    addLog('WARN', formatMessage(args));
};

console.error = (...args) => {
    originalError(...args);
    addLog('ERROR', formatMessage(args));
};

module.exports = {
    getLogs: () => [...logBuffer],
    clearLogs: () => { logBuffer.length = 0; }
};
