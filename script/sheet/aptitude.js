import { RogueTraderItemSheet } from "./item.js";

export class AptitudeSheet extends RogueTraderItemSheet {
    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            classes: ["rogue-trader", "sheet", "aptitude"],
            template: "systems/rogue-trader/template/sheet/aptitude.hbs",
            width: 500,
            height: 369,
            resizable: false,
            tabs: [
                {
                    navSelector: ".sheet-tabs",
                    contentSelector: ".sheet-body",
                    initial: "stats"
                }
            ]
        });
    }
}
