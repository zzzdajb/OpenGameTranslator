import type { GameEngineAdapter } from "./GameEngineAdapter.js";
import { Cocos2dJsAdapter } from "./cocos2d-js/Cocos2dJsAdapter.js";
import { TyranoScriptAdapter } from "./tyrano/TyranoScriptAdapter.js";

export class EngineRegistry {
    public getAdapters(): readonly GameEngineAdapter[] {
        return [
            new TyranoScriptAdapter(),
            new Cocos2dJsAdapter()
        ];
    }
}
