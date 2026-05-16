import type { GameEngineAdapter } from "./GameEngineAdapter.js";
import { TyranoScriptAdapter } from "./tyrano/TyranoScriptAdapter.js";

export class EngineRegistry {
    public getAdapters(): readonly GameEngineAdapter[] {
        return [
            new TyranoScriptAdapter()
        ];
    }
}

