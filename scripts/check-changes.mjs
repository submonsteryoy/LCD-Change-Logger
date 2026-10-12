import fs from "node:fs/promises";

const DATA_URL =
    process.env.LCD_DATA_URL ||
    "https://api-lcd.vercel.app/levels";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const SNAPSHOT_FILE = "state/lcd-snapshot.json";

if (!WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL is missing");
}

function getTier(rank) {
    if (rank <= 15) return "Main";
    if (rank <= 30) return "Extended";
    return "Forgotten";
}

function normalize(item) {
    const rank = Number(item.rank);

    return {
        key: String(item.level_id ?? item.id),
        level_id: item.level_id ?? null,
        title: item.title ?? "Unknown Level",
        creator: item.creator ?? "Unknown Creator",
        difficulty: item.difficulty ?? "Unknown",
        rank: Number.isFinite(rank) ? rank : null,
    };
}

async function loadCurrentData() {
    const response = await fetch(DATA_URL, {
        headers: {
            "User-Agent": "LCD-Change-Logger/1.0",
        },
    });

    if (!response.ok) {
        throw new Error(
            `LCD API returned ${response.status} ${response.statusText}`
        );
    }

    const json = await response.json();

    const items = Array.isArray(json)
        ? json
        : Array.isArray(json.items)
        ? json.items
        : null;

    if (!items) {
        throw new Error("Could not find level array in API response");
    }

    return items
        .map(normalize)
        .filter((item) => item.key && item.rank !== null)
        .sort((a, b) => a.rank - b.rank);
}

async function loadPreviousData() {
    try {
        const raw = await fs.readFile(SNAPSHOT_FILE, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function compare(oldLevels, newLevels) {
    const oldMap = new Map(oldLevels.map((x) => [x.key, x]));
    const newMap = new Map(newLevels.map((x) => [x.key, x]));

    const added = [];
    const removed = [];
    const rankChanges = [];
    const tierChanges = [];
    const edits = [];

    for (const current of newLevels) {
        const previous = oldMap.get(current.key);

        if (!previous) {
            added.push(current);
            continue;
        }

        if (previous.rank !== current.rank) {
            rankChanges.push({
                level: current,
                from: previous.rank,
                to: current.rank,
            });

            const oldTier = getTier(previous.rank);
            const newTier = getTier(current.rank);

            if (oldTier !== newTier) {
                tierChanges.push({
                    level: current,
                    from: oldTier,
                    to: newTier,
                    oldRank: previous.rank,
                    newRank: current.rank,
                });
            }
        }

        const changedFields = [];

        for (const field of ["title", "creator", "difficulty", "level_id"]) {
            if (previous[field] !== current[field]) {
                changedFields.push({
                    field,
                    oldValue: previous[field],
                    newValue: current[field],
                });
            }
        }

        if (changedFields.length) {
            edits.push({
                level: current,
                fields: changedFields,
            });
        }
    }

    for (const previous of oldLevels) {
        if (!newMap.has(previous.key)) {
            removed.push(previous);
        }
    }

    return {
        added,
        removed,
        rankChanges,
        tierChanges,
        edits,
    };
}

function makeMessage(changes) {
    const lines = [];

    if (changes.added.length) {
        lines.push("### 🆕 Levels Added");

        for (const level of changes.added.slice(0, 10)) {
            lines.push(
                `**#${level.rank} ${level.title}** — ${level.creator} (${getTier(level.rank)})`
            );
        }

        lines.push("");
    }

    if (changes.removed.length) {
        lines.push("### 🗑️ Levels Removed");

        for (const level of changes.removed.slice(0, 10)) {
            lines.push(
                `**#${level.rank} ${level.title}** — ${level.creator}`
            );
        }

        lines.push("");
    }

    if (changes.tierChanges.length) {
        lines.push("### 🔀 List Changes");

        for (const change of changes.tierChanges.slice(0, 10)) {
            lines.push(
                `**${change.level.title}** — #${change.oldRank} ${change.from} → #${change.newRank} ${change.to}`
            );
        }

        lines.push("");
    }

    if (changes.rankChanges.length) {
        lines.push("### 📊 Rank Changes");

        for (const change of changes.rankChanges.slice(0, 20)) {
            const direction =
                change.to < change.from ? "⬆️" : "⬇️";

            lines.push(
                `${direction} **${change.level.title}**: #${change.from} → #${change.to}`
            );
        }

        lines.push("");
    }

    if (changes.edits.length) {
        lines.push("### ✏️ Level Information Updated");

        for (const edit of changes.edits.slice(0, 10)) {
            lines.push(`**${edit.level.title}**`);

            for (const field of edit.fields) {
                lines.push(
                    `• ${field.field}: \`${field.oldValue}\` → \`${field.newValue}\``
                );
            }
        }

        lines.push("");
    }

    return lines.join("\n").slice(0, 3900);
}

function hasChanges(changes) {
    return (
        changes.added.length ||
        changes.removed.length ||
        changes.rankChanges.length ||
        changes.tierChanges.length ||
        changes.edits.length
    );
}

async function sendDiscord(message) {
    const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            username: "LCD Logger",
            embeds: [
                {
                    title: "LCD Community List Update",
                    description: message,
                    timestamp: new Date().toISOString(),
                },
            ],
        }),
    });

    if (!response.ok) {
        throw new Error(
            `Discord webhook failed: ${response.status}`
        );
    }
}

async function saveSnapshot(levels) {
    await fs.mkdir("state", { recursive: true });

    await fs.writeFile(
        SNAPSHOT_FILE,
        JSON.stringify(levels, null, 2) + "\n"
    );
}

const current = await loadCurrentData();
const previous = await loadPreviousData();

if (!previous) {
    console.log(
        `Creating initial baseline with ${current.length} levels. No Discord message will be sent.`
    );

    await saveSnapshot(current);
    process.exit(0);
}

const changes = compare(previous, current);

if (!hasChanges(changes)) {
    console.log("No LCD changes detected.");
    process.exit(0);
}

const message = makeMessage(changes);

console.log(message);

await sendDiscord(message);
await saveSnapshot(current);

console.log("Discord log sent and snapshot updated.");
