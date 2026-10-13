import pino from 'pino';

export const apiLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
