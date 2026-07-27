import { BeanModel } from "redbean-node/dist/bean-model";
import { R } from "redbean-node";
import { LooseObject } from "../../common/util-common";

export class Agent extends BeanModel {

    static async getAgentList() : Promise<Record<string, Agent>> {
        let list = await R.findAll("agent") as Agent[];
        let result : Record<string, Agent> = {};
        for (let agent of list) {
            result[agent.endpoint] = agent;
        }
        return result;
    }

    get endpoint() : string {
        let obj = new URL(this.url);
        return obj.host;
    }

    get authMode() : "password" | "token" {
        return this.auth_mode === "token" ? "token" : "password";
    }

    get credentials() {
        if (this.authMode === "token") {
            return {
                authMode: "token" as const,
                token: this.token,
            };
        }

        return {
            authMode: "password" as const,
            username: this.username,
            password: this.password,
        };
    }

    toJSON() : LooseObject {
        return {
            url: this.url,
            username: this.username,
            endpoint: this.endpoint,
            name: this.name,
            authMode: this.authMode,
        };
    }

}

export default Agent;
