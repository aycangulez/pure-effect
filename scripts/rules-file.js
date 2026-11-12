// @ts-check

/**
 * Generates RULES.md, the rules for writing a flow and an index of where the README and the guides cover each task,
 * which ships in the package so an agent that sees only node_modules finds them. The rules are copied from between
 * the markers in README.md, with each link pointed at README.md; the task index is the list below. Run
 * `npm run generate` after editing either; a test fails when RULES.md and this output differ, so RULES.md is never
 * edited by hand.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';

export const BEGIN = '<!-- rules:start -->';
export const END = '<!-- rules:end -->';

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const rulesPath = fileURLToPath(new URL('../RULES.md', import.meta.url));

/** The guides the README hands a subject to. A heading both hold is linked in the guide, which teaches it. */
export const GUIDES = [
    'guides/failures.md',
    'guides/typescript.md',
    'guides/time-travel.md',
    'guides/recording.md',
    'guides/hooks.md'
];

/** Each task, and the headings in the README or a guide that cover it, by their text as written. */
const TASKS = /** @type {[string, string[]][]} */ ([
    ['Test a decision or a branch without mocks', ['Testing Without Mocks']],
    [
        'Run a whole flow in a test from a table of answers, a retry that fails and then succeeds included',
        ['Testing a whole flow']
    ],
    ['Write a flow that reads like `async` code', ['Writing Flows as Generators']],
    ['Port an `async` function, `try`/`catch` included', ['Coming from async/await', 'Translating `try`/`catch`']],
    ['Read request values such as a tenant or a request ID', ['Passing Runtime Context']],
    ['Run a flow against fakes or a test database', ['Passing Runtime Context']],
    ['Retry a flaky call, or only some of its errors', ['Retrying Transient Failures', 'Which Errors Are Data']],
    ['Wait as long as a server asks before trying again', ['Waiting as long as the server asks']],
    ['Run steps at the same time, with a limit', ['Running Effects in Parallel']],
    ['Undo what succeeded when a branch fails', ['Undoing what succeeded when a branch fails']],
    ['Loop over a list', ['Writing Loops']],
    ["End a flow early with a result that isn't an error", ['Ending a flow early without an error']],
    ['Record every run in production', ['Recording in Production']],
    ['Keep secrets out of a trace', ['Keeping secrets out of a trace']],
    ['Turn a production incident into a test', ['Time-Travel Debugging']],
    ['Prove a fix with a recorded trace', ["Proving a fix that changes the flow's shape"]],
    ['Check that a replay decides what the recorded run decided', ['Checking that a replay ends the same way']],
    ['Add telemetry', ['Tracing with OpenTelemetry']],
    ["Type a flow's errors and context", ['TypeScript: Typed Errors and Context']],
    ['Handle every error a flow can end with, in TypeScript', ['Handling every error']],
    ['Test a flow in TypeScript', ['Testing a flow in TypeScript']]
]);

/**
 * The anchor GitHub gives a heading: lowercased, with everything but letters, digits, spaces, `-` and `_` removed,
 * and spaces turned into `-`.
 * @param {string} heading
 */
export const githubAnchor = (heading) =>
    heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, '')
        .replace(/ /g, '-');

/**
 * Every anchor the README's headings get, skipping `#` lines inside fenced code. A repeated heading gets `-1`, `-2`
 * and so on, as on GitHub.
 * @param {string} markdown
 */
export const headingAnchors = (markdown) => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    /** @type {string[]} */
    const anchors = [];
    for (const match of markdown.matchAll(/^(#+) (.*)$|```[\s\S]*?```/gm)) {
        if (!match[1]) continue;
        const anchor = githubAnchor(match[2]);
        const count = seen.get(anchor) ?? 0;
        anchors.push(count === 0 ? anchor : `${anchor}-${count}`);
        seen.set(anchor, count + 1);
    }
    return anchors;
};

/**
 * The rules list between the README's markers.
 * @param {string} readme
 */
export const rulesSection = (readme) => {
    const start = readme.indexOf(BEGIN);
    const end = readme.indexOf(END);
    if (start === -1 || end < start || readme.indexOf(BEGIN, start + 1) !== -1 || readme.indexOf(END, end + 1) !== -1) {
        throw new Error(`README.md needs exactly one '${BEGIN}' ... '${END}' block.`);
    }
    return readme.slice(start + BEGIN.length, end).trim();
};

/**
 * The text of RULES.md, built from the README and the guides.
 * @param {string} readme
 * @param {Record<string, string>} guides - Each guide's text, by its file name
 */
export async function rulesFile(readme, guides) {
    const rules = rulesSection(readme).replace(/\]\(#/g, '](README.md#');
    const fileOf = (/** @type {string} */ anchor) =>
        Object.keys(guides).find((name) => headingAnchors(guides[name]).includes(anchor)) ?? 'README.md';
    const link = (/** @type {string} */ heading) => {
        const anchor = githubAnchor(heading);
        return `[${heading}](${fileOf(anchor)}#${anchor})`;
    };
    const tasks = TASKS.map(([task, headings]) => `- ${task}: ${headings.map(link).join(', ')}`);
    const source = [
        '# Rules for Writing a Pure Effect Flow',
        '<!-- Generated by scripts/rules-file.js from README.md: edit those, then run npm run generate. -->',
        'The rules for writing a correct flow, and where the README and the guides cover each task.',
        '## Rules',
        rules,
        '## Find It by Task',
        tasks.join('\n')
    ].join('\n\n');
    const options = (await prettier.resolveConfig(rulesPath)) ?? {};
    return prettier.format(source, { ...options, parser: 'markdown' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const guides = Object.fromEntries(
        await Promise.all(
            GUIDES.map(async (name) => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')])
        )
    );
    const generated = await rulesFile(await readFile(readmePath, 'utf8'), guides);
    const current = await readFile(rulesPath, 'utf8').catch(() => '');
    if (generated === current) {
        console.log('RULES.md: already up to date.');
    } else {
        await writeFile(rulesPath, generated);
        console.log('RULES.md: written.');
    }
}
