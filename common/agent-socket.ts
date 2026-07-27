export class AgentSocket {

    eventList : Map<string, (...args : unknown[]) => void | Promise<void>> = new Map();

    on(event : string, callback : (...args : unknown[]) => void | Promise<void>) {
        this.eventList.set(event, callback);
    }

    async call(eventName : string, ...args : unknown[]) {
        const callback = this.eventList.get(eventName);
        if (callback) {
            await callback(...args);
        }
    }
}
