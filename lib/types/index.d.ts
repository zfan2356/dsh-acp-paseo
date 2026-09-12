import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Stream } from '@agentclientprotocol/sdk';
import '@deepseek-ai/dsh-user-approval';
import '@deepseek-ai/dsh-plan-mode';
import '@deepseek-ai/dsh-commands';
import '@deepseek-ai/dsh-agent-default-model';
export declare const name = "dsh-acp-paseo";
/** The bridge creates and owns agents; every other concern is carried by the composition. */
export declare const inject: string[];
export interface BridgeConfig {
    provider?: string;
    model?: string;
    commandBlocklist?: string[];
    /** Test-only transport override; never declared in the config schema. */
    stream?: Stream;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    provider: Schema<string, string>;
    model: Schema<string, string>;
    commandBlocklist: Schema<string[], string[]>;
}>, Schemastery.ObjectT<{
    provider: Schema<string, string>;
    model: Schema<string, string>;
    commandBlocklist: Schema<string[], string[]>;
}>>;
/**
 * Mount the Paseo-facing ACP bridge.
 * @param ctx - Cordis context of the dsh profile.
 * @param config - Optional provider/model pins, command blocklist, test transport.
 */
export declare function apply(ctx: Context, config: BridgeConfig): void;
