import type { Logger } from "../core/Logger.js";

export class ConsoleLogger implements Logger {
    public info(message: string): void {
        console.log(message);
    }

    public warn(message: string): void {
        console.warn(message);
    }

    public error(message: string): void {
        console.error(message);
    }
}
