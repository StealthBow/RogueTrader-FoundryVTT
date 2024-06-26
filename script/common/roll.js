import {PlaceableTemplate} from "./placeable-template.js";

/**
 * Roll a generic roll, and post the result to chat.
 * @param {object} rollData
 */
export async function commonRoll(rollData) {
    await _computeCommonTarget(rollData);
    await _rollTarget(rollData);
    if (rollData.isEvasion) {
        rollData.numberOfHits = _computeNumberOfHits(
            rollData.attackDos,
            rollData.dos,
            rollData.attackType,
            rollData.weaponTraits);
            if (rollData.isSuccess) {
                // -1 as a Success with 0 Degrees success still reduces the hits by 1
                rollData.numberOfHits = Math.max(rollData.numberOfHits -1, 0);
            }
    }
    await _sendRollToChat(rollData);
}

/**
 * Roll a combat roll, and post the result to chat.
 * @param {object} rollData
 */
export async function combatRoll(rollData) {
    if (rollData.weaponTraits.flame && game.settings.get("rogue-trader", "useFlametemplate")) {
        let template = PlaceableTemplate.cone(rollData.itemId, 30, rollData.range);
        await template.drawPreview();
    }
    if (rollData.weaponTraits.skipAttackRoll) {
        rollData.attackResult = 5; // Attacks that skip the hit roll always hit body; 05 reversed 50 = body
        rollData.isDamageRoll = true;
        await _rollDamage(rollData);
        await sendDamageToChat(rollData);
    } else {
        await _computeCombatTarget(rollData);
        await _rollTarget(rollData);
        rollData.attackDos = rollData.dos;
        rollData.attackResult = rollData.result;
        rollData.numberOfHits = _computeNumberOfHits(
            rollData.attackDos,
            0,
            rollData.attackType,
            rollData.weaponTraits);
        await _sendRollToChat(rollData);
    }

}

/**
 * Roll damage for an attack and post the result to chat
 * @param {object} rollData
 */
export async function damageRoll(rollData) {
    await _rollDamage(rollData);
    await sendDamageToChat(rollData);
}

/**
 * Post an "empty clip, need to reload" message to chat.
 * @param {object} rollData
 */
export async function reportEmptyClip(rollData) {
    await _emptyClipToChat(rollData);
}

/**
 * Compute the target value, including all +/-modifiers, for a roll.
 * @param {object} rollData
 */
async function _computeCombatTarget(rollData) {

    let attackType = 0;
    if (rollData.attackType) {
        _computeRateOfFire(rollData);
        attackType = rollData.attackType.modifier;
    }
    let psyModifier = 0;
    if (typeof rollData.psy !== "undefined" && typeof rollData.psy.useModifier !== "undefined" && rollData.psy.useModifier) {
    // Set Current Psyrating to the allowed maximum if it is bigger
        if (rollData.psy.value > rollData.psy.max) {
            rollData.psy.value = rollData.psy.max;
        }
        psyModifier = (rollData.psy.rating - rollData.psy.value) * 10;
        rollData.psy.push = psyModifier < 0;
        if (rollData.psy.push && rollData.psy.warpConduit) {
            let ratingBonus = new Roll("1d5").evaluate({ async: false }).total;
            rollData.psy.value += ratingBonus;
        }
    }

    let targetMods = rollData.modifier
    + (rollData.aim?.val ? rollData.aim.val : 0)
    + (rollData.range ? rollData.range : 0)
    + (rollData.weaponTraits?.twinLinked ? 20: 0)
    + attackType
    + psyModifier;

    rollData.target = _getRollTarget(targetMods, rollData.baseTarget);
}

/**
 * Compute the target value, including all +/-modifiers, for a roll.
 * @param {object} rollData
 */
async function _computeCommonTarget(rollData) {
    if (rollData.isEvasion) {
        let skill;
        switch (rollData.evasions.selected) {
            case "dodge": skill = rollData.evasions.dodge; break;
            case "parry": skill = rollData.evasions.parry; break;
        }
        rollData.target = _getRollTarget(rollData.modifier, skill.baseTarget);
    } else {
        rollData.target = _getRollTarget(rollData.modifier, rollData.baseTarget);
    }
}

/**
 * Checks and adjusts modifiers for the rolls target number and returns the final target number
 * @param {int} targetMod calculated bonuses
 * @param {int} baseTarget the intial target value to be modified
 * @returns {int} the final target number
 */
function _getRollTarget(targetMod, baseTarget) {
    if (targetMod > 60) {
        return baseTarget + 60;
    } else if (targetMod < -60) {
        return baseTarget + -60;
    } else {
        return baseTarget + targetMod;
    }
}


/**
 * Roll a d100 against a target, and apply the result to the rollData.
 * @param {object} rollData
 */
async function _rollTarget(rollData) {
    let r = new Roll("1d100", {});
    r.evaluate({ async: false });
    rollData.result = r.total;
    rollData.rollObject = r;
    rollData.isSuccess = rollData.result <= rollData.target;
    if (rollData.isSuccess) {
        rollData.dof = 0;
        rollData.dos = _getDegree(rollData.target, rollData.result);
    } else {
        rollData.dos = 0;
        rollData.dof = _getDegree(rollData.result, rollData.target);
    }
    if (rollData.psy) _computePsychicPhenomena(rollData);
}
/**
 * Handle rolling and collecting parts of a combat damage roll.
 * @param {object} rollData
 */
async function _rollDamage(rollData) {
    let formula = "0";
    rollData.damages = [];
    if (rollData.damageFormula) {
        formula = rollData.damageFormula;

        if (rollData.weaponTraits.tearing) {
            formula = _appendTearing(formula);
        }
        if (rollData.weaponTraits.proven) {
            formula = _appendNumberedDiceModifier(formula, "min", rollData.weaponTraits.proven);
        }
        if (rollData.weaponTraits.primitive) {
            formula = _appendNumberedDiceModifier(formula, "max", rollData.weaponTraits.primitive);
        }

        formula = `${formula}+${rollData.damageBonus}`;
        formula = _replaceSymbols(formula, rollData);
    }


    let penetration = _rollPenetration(rollData);

    let firstHit = await _computeDamage(
        formula,
        penetration,
        rollData.attackDos,
        rollData.aim?.isAiming,
        rollData.weaponTraits
    );
    const firstLocation = _getLocation(rollData.attackResult);
    firstHit.location = firstLocation;
    rollData.damages.push(firstHit);

    let stormMod = rollData.weaponTraits.storm ? 2 : 1;

    let additionalhits = (rollData.numberOfHits * stormMod) - 1;

    for (let i = 0; i < additionalhits; i++) {
        let additionalHit = await _computeDamage(
            formula,
            penetration,
            rollData.attackDos,
            rollData.aim?.isAiming,
            rollData.weaponTraits
        );
        additionalHit.location = _getAdditionalLocation(firstLocation, i);
        rollData.damages.push(additionalHit);
    }

    let minDamage = rollData.damages.reduce(
        (min, damage) => min.minDice < damage.minDice ? min : damage, rollData.damages[0]);

    if (minDamage.minDice < rollData.dos) {
        minDamage.total += (rollData.dos - minDamage.minDice);
    }
}

/**
 * Calculates the amount of hits of a successful attack
 * @param {int} attackDos Degrees of success on the Attack
 * @param {int} evasionDos Degrees of success on the Evasion
 * @param {object} attackType The mode of attack and its parameters
 * @param {object} weaponTraits The traits of the weapon used for the attack
 * @returns {int} the number of hits the attack has scrored
 */
function _computeNumberOfHits(attackDos, evasionDos, attackType, weaponTraits) {

    if (weaponTraits.twinLinked && attackDos >=2) {
        maxHits += 1;
        attackDos += attackType.hitMargin;
    }

    let hits = 1 + Math.floor(attackDos / attackType.hitMargin);

    if (hits > attackType.maxHits) {
        hits = attackType.maxHits;
    }

    hits -= evasionDos;

    if (hits <= 0) {
        return 0;
    } else {
        return hits;
    }
}

/**
 * Roll and compute damage.
 * @param {string} damageFormula
 * @param {number} penetration
 * @param {number} dos
 * @param {boolean} isAiming
 * @param {object} weaponTraits
 * @returns {object}
 */
async function _computeDamage(damageFormula, penetration, dos, isAiming, weaponTraits) {
    let r = new Roll(damageFormula);
    r.evaluate({ async: false });
    let damage = {
        total: r.total,
        righteousFury: false,
        dices: [],
        penetration: penetration,
        dos: dos,
        formula: damageFormula,
        replaced: false,
        damageRender: await r.render(),
        damageRoll: r
    };

    if (weaponTraits.accurate && isAiming) {
        let numDice = ~~(dos / 2);
        if (numDice >= 1) {
            if (numDice > 2) numDice = 2;
            let ar = new Roll(`${numDice}d10`);
            ar.evaluate({ async: false });
            damage.total += ar.total;
            ar.terms.flatMap(term => term.results).forEach(async die => {
                if (die.active && die.result < dos) damage.dices.push(die.result);
                if (die.active && (typeof damage.minDice === "undefined" || die.result < damage.minDice)) damage.minDice = die.result;
            });
            damage.accurateRender = await ar.render();
        }
    }

    r.terms.forEach(term => {
        if (typeof term === "object" && term !== null) {
            let rfFace = term.faces;
            term.results?.forEach(async result => {
                let dieResult = result.count ? result.count : result.result; // Result.count = actual value if modified by term
                if (result.active && dieResult >= rfFace) damage.righteousFury = true;
                if (result.active && dieResult < dos) damage.dices.push(dieResult);
                if (result.active && (typeof damage.minDice === "undefined" || dieResult < damage.minDice)) damage.minDice = dieResult;
            });
        }
    });
    return damage;
}

/**
 * Evaluate final penetration, by leveraging the dice roll API.
 * @param {object} rollData
 * @returns {number}
 */
function _rollPenetration(rollData) {
    let penetration = (rollData.penetrationFormula) ? _replaceSymbols(rollData.penetrationFormula, rollData) : "0";
    let multiplier = 1;

    if (rollData.dos >= 3) {
        if (penetration.includes("(")) // Legacy Support
        {
            let rsValue = penetration.match(/\(\d+\)/gi); // Get Razorsharp Value
            penetration = penetration.replace(/\d+.*\(\d+\)/gi, rsValue); // Replace construct BaseValue(RazorsharpValue) with the extracted date
        } else if (rollData.weaponTraits.razorSharp) {
            multiplier = 2;
        }
    }
    let r = new Roll(penetration.toString());
    r.evaluate({ async: false });
    return r.total * multiplier;
}

/**
 * Check for psychic phenomena (i.e, the user rolled two matching numbers, etc.), and add the result to the rollData.
 * @param {object} rollData
 */
function _computePsychicPhenomena(rollData) {
    rollData.psy.hasPhenomena = rollData.psy.push ? !_isDouble(rollData.result) : _isDouble(rollData.result);
}

/**
 * Check if a number (d100 roll) has two matching digits.
 * @param {number} number
 * @returns {boolean}
 */
function _isDouble(number) {
    if (number === 100) {
        return true;
    } else {
        const digit = number % 10;
        return number - digit === digit * 10;
    }
}

/**
 * Get the hit location from a WS/BS roll.
 * @param {number} result
 * @returns {string}
 */
function _getLocation(result) {
    const toReverse = result < 10 ? `0${result}` : result.toString();
    const locationTarget = parseInt(toReverse.split("").reverse().join(""));
    if (locationTarget <= 10) {
        return "ARMOUR.HEAD";
    } else if (locationTarget <= 20) {
        return "ARMOUR.RIGHT_ARM";
    } else if (locationTarget <= 30) {
        return "ARMOUR.LEFT_ARM";
    } else if (locationTarget <= 70) {
        return "ARMOUR.BODY";
    } else if (locationTarget <= 85) {
        return "ARMOUR.RIGHT_LEG";
    } else if (locationTarget <= 100) {
        return "ARMOUR.LEFT_LEG";
    } else {
        return "ARMOUR.BODY";
    }
}

/**
 * Calculate modifiers/etc. from RoF type, and add them to the rollData.
 * @param {object} rollData
 */
function _computeRateOfFire(rollData) {
    switch (rollData.attackType.name) {
        case "standard":
        case "bolt":
        case "blast":
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "semi_auto":
            rollData.attackType.modifier = 10;
            rollData.attackType.hitMargin = 2;
            rollData.attackType.maxHits = rollData.rateOfFire.burst;
            break;

        case "barrage":
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 2;
            rollData.attackType.maxHits = rollData.rateOfFire.burst;
            break;

        case "full_auto":
            rollData.attackType.modifier = 20;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = rollData.rateOfFire.full;
            break;

        case "suppressing_fire":
            rollData.attackType.modifier = -20;
            rollData.attackType.hitMargin = 2;
            rollData.attackType.maxHits = rollData.rateOfFire.full;
            break;

        case "called_shot":
            rollData.attackType.modifier = -20;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "charge":
            rollData.attackType.modifier = 10;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "allOut":
            rollData.attackType.modifier = 20;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "guarded":
            rollData.attackType.modifier = -10;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        default:
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;
    }
}

const additionalHit = {
    head: ["ARMOUR.HEAD", "ARMOUR.RIGHT_ARM", "ARMOUR.BODY", "ARMOUR.LEFT_ARM", "ARMOUR.BODY"],
    rightArm: ["ARMOUR.RIGHT_ARM", "ARMOUR.BODY", "ARMOUR.HEAD", "ARMOUR.BODY", "ARMOUR.RIGHT_ARM"],
    leftArm: ["ARMOUR.LEFT_ARM", "ARMOUR.BODY", "ARMOUR.HEAD", "ARMOUR.BODY", "ARMOUR.LEFT_ARM"],
    body: ["ARMOUR.BODY", "ARMOUR.RIGHT_ARM", "ARMOUR.HEAD", "ARMOUR.LEFT_ARM", "ARMOUR.BODY"],
    rightLeg: ["ARMOUR.RIGHT_LEG", "ARMOUR.BODY", "ARMOUR.RIGHT_ARM", "ARMOUR.HEAD", "ARMOUR.BODY"],
    leftLeg: ["ARMOUR.LEFT_LEG", "ARMOUR.BODY", "ARMOUR.LEFT_ARM", "ARMOUR.HEAD", "ARMOUR.BODY"]
};

/**
 * Get successive hit locations for an attack which scored multiple hits.
 * @param {string} firstLocation
 * @param {number} numberOfHit
 * @returns {string}
 */
function _getAdditionalLocation(firstLocation, numberOfHit) {
    if (firstLocation === "ARMOUR.HEAD") {
        return _getLocationByIt(additionalHit.head, numberOfHit);
    } else if (firstLocation === "ARMOUR.RIGHT_ARM") {
        return _getLocationByIt(additionalHit.rightArm, numberOfHit);
    } else if (firstLocation === "ARMOUR.LEFT_ARM") {
        return _getLocationByIt(additionalHit.leftArm, numberOfHit);
    } else if (firstLocation === "ARMOUR.BODY") {
        return _getLocationByIt(additionalHit.body, numberOfHit);
    } else if (firstLocation === "ARMOUR.RIGHT_LEG") {
        return _getLocationByIt(additionalHit.rightLeg, numberOfHit);
    } else if (firstLocation === "ARMOUR.LEFT_LEG") {
        return _getLocationByIt(additionalHit.leftLeg, numberOfHit);
    } else {
        return _getLocationByIt(additionalHit.body, numberOfHit);
    }
}

/**
 * Lookup hit location from array.
 * @param {Array} part
 * @param {number} numberOfHit
 * @returns {string}
 */
function _getLocationByIt(part, numberOfHit) {
    const index = numberOfHit > (part.length - 1) ? part.length - 1 : numberOfHit;
    return part[index];
}


/**
 * Get degrees of success/failure from a target and a roll.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function _getDegree(a, b) {
    return Math.floor((a - b) / 10);
}
/**
 * Replaces all Symbols in the given Formula with their Respective Values
 * The Symbols consist of Attribute Boni and Psyrating
 * @param {*} formula
 * @param {*} rollData
 * @returns {string}
 */
function _replaceSymbols(formula, rollData) {
    let actor = game.actors.get(rollData.ownerId);
    let attributeBoni = actor.attributeBoni;
    if (rollData.psy) {
        formula = formula.replaceAll(/PR/gi, rollData.psy.value);
    }
    for (let boni of attributeBoni) {
        formula = formula.replaceAll(boni.regex, boni.value);
    }
    return formula;
}

/**
 * Add a special weapon modifier value to a roll formula.
 * @param {string} formula
 * @param {string} modifier
 * @param {number} value
 * @returns {string}
 */
function _appendNumberedDiceModifier(formula, modifier, value) {
    let diceRegex = /\d+d\d+/;
    if (!formula.includes(modifier)) {
        let match = formula.match(diceRegex);
        if (match) {
            let dice = match[0];
            dice += `${modifier}${value}`;
            formula = formula.replace(diceRegex, dice);
        }
    }
    return formula;
}

/**
 * Add the "tearing" special weapon modifier to a roll formula.
 * @param {string} formula
 * @returns {string}
 */
function _appendTearing(formula) {
    let diceRegex = /\d+d\d+/;
    if (!formula.match(/dl|kh/gi, formula)) { // Already has drop lowest or keep highest
        let match = formula.match(/\d+/g, formula);
        let numDice = parseInt(match[0]) + 1;
        let faces = parseInt(match[1]);
        let diceTerm = `${numDice}d${faces}dl`;
        formula = formula.replace(diceRegex, diceTerm);
    }
    return formula;
}

/**
 * Post a roll to chat.
 * @param {object} rollData
 */
async function _sendRollToChat(rollData) {
    let speaker = ChatMessage.getSpeaker();
    let chatData = {
        user: game.user.id,
        type: CONST.CHAT_MESSAGE_TYPES.ROLL,
        rollMode: game.settings.get("core", "rollMode"),
        speaker: speaker,
        flags: {
            "rogue-trader.rollData": rollData
        }
    };

    if (speaker.token) {
        rollData.tokenId = speaker.token;
    }

    if (rollData.rollObject) {
        rollData.render = await rollData.rollObject.render();
        chatData.roll = rollData.rollObject;
    }

    let html;
    if (rollData.isEvasion) {
        html = await renderTemplate("systems/rogue-trader/template/chat/evasion.hbs", rollData);
    } else {
        html = await renderTemplate("systems/rogue-trader/template/chat/roll.hbs", rollData);
    }
    chatData.content = html;

    if (["gmroll", "blindroll"].includes(chatData.rollMode)) {
        chatData.whisper = ChatMessage.getWhisperRecipients("GM");
    } else if (chatData.rollMode === "selfroll") {
        chatData.whisper = [game.user];
    }

    ChatMessage.create(chatData);
}
/**
 * Post rolled damage to chat.
 * @param {object} rollData
 */
export async function sendDamageToChat(rollData) {
    let speaker = ChatMessage.getSpeaker();
    let chatData = {
        user: game.user.id,
        type: CONST.CHAT_MESSAGE_TYPES.ROLL,
        rollMode: game.settings.get("core", "rollMode"),
        speaker: speaker,
        flags: {
            "rogue-trader.rollData": rollData
        }
    };

    if (speaker.token) {
        rollData.tokenId = speaker.token;
    }

    chatData.roll = rollData.damages[0].damageRoll;

    const html = await renderTemplate("systems/rogue-trader/template/chat/damage.hbs", rollData);
    chatData.content = html;

    if (["gmroll", "blindroll"].includes(chatData.rollMode)) {
        chatData.whisper = ChatMessage.getWhisperRecipients("GM");
    } else if (chatData.rollMode === "selfroll") {
        chatData.whisper = [game.user];
    }

    ChatMessage.create(chatData);
}

/**
 * Post a "you need to reload" message to chat.
 * @param {object} rollData
 */
async function _emptyClipToChat(rollData) {
    let chatData = {
        user: game.user.id,
        content: await renderTemplate("systems/rogue-trader/template/chat/emptyMag.hbs", rollData),
        flags: {
            "rogue-trader.rollData": rollData
        }
    };
    ChatMessage.create(chatData);
}
