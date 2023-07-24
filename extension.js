const axios = require('axios').default;
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const {marked} = require('marked');
const vscode = require('vscode');
const {ChatOpenAI} = require('langchain/chat_models/openai');
const {PromptTemplate} = require('langchain/prompts');
const {SystemMessage} = require('langchain/schema');

const extensionName = "gptInvestigate"

const entryPrompt = `
As a contributor to a git project, your goal is to provide a concise detailed analysis of the following code and it's history in the project:
"""
{code_text}
"""

You'll be provided a list of commit details from 'git show' and pull request details associated with that code. The list will be in chronological order from oldest to newest.
`

const commitPrompt = `
Git show command output:
"""
{show_text}
"""

Pull request title:
"""
{pr_title}
"""

Pull request body:
"""
{pr_body}
"""

Pull request URL:
"""
{pr_url}
"""
`;

const outputPrompt = `
Based on what is known from the commit(s), answer the following:
1. Explain the current state of the code
2. Explain why the code was added originally added
3. Based on the history give details if the codes meaning has been changed or altered
4. Provide a list of commits + PR links that exist and add dates if possible
5. Include a list of everyone who has worked on this code with contact information

Constraints:
 - Be concise to limit read time
 - Provide shortened commit hashes
 - Output your result into markdown format, utilize code blocks, tables and other formatting options
 - Only provide the output inside the below template (excluding the triple quotes) and add your response to each section in brackets

Template:
"""
# Code Inspection Results

## 1. Current State
{ADD CONTEXT}

## 2. Explanation
{ADD CONTEXT}

## 3. History
{ADD CONTEXT}

## 4. References
- {ADD CONTEXT}

## 5. Contributors
The following individuals have contributed to this code:
- {ADD CONTEXT}
"""
`

let config = vscode.workspace.getConfiguration(extensionName);

let {openAIApiKey, gitPAT} = getSecrets(config);
let temperature = config.get('openAI.temperature')
let modelName = config.get('openAI.modelName')
let maxTokens = config.get('openAI.maxTokens')

/**
 * Activation entry point
 *
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(extensionName)) {
            let config = vscode.workspace.getConfiguration(extensionName);
            openAIApiKey = config.get('openAI.apiKey');
            gitPAT = config.get('git.accessToken');
            temperature = config.get('openAI.temperature')
            modelName = config.get('openAI.modelName')
            maxTokens = config.get('openAI.maxTokens')
        }
    });

    let disposable = vscode.commands.registerCommand(extensionName + '.myRightClickCommand', handleGPTInvestigateCommand);

    context.subscriptions.push(disposable);
}

/**
 * Handles the execution of the gptInvestigate command
 */
async function handleGPTInvestigateCommand() {
    if (!openAIApiKey) {
        vscode.window.showErrorMessage(`OpenAI API Key not found in settings or environment variable (OPENAI_API_KEY)`);
        return
    }

    let activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    let workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('The current active editor is not in a workspace');
        return;
    }

    let isGit = await isGitRepo(workspaceFolder.uri.fsPath);
    if (!isGit) {
        vscode.window.showWarningMessage(`The workspace is not a Git repository`);
        return;
    }

    if (activeEditor) {
        let document = activeEditor.document;
        let selection = activeEditor.selection;
        let text = document.getText(selection);
        if (text.length === 0) {
            vscode.window.showWarningMessage('No text was selected!');
            return;
        }

        try {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "GPT Investigate Process",
                cancellable: true
            }, async (progress, token) => {
                progress.report({increment: 0, message: "Starting"});
                vscode.window.showInformationMessage('Inspecting code snippet, this might take a few seconds...');


                if (token.isCancellationRequested) {
                    return
                }
                progress.report({increment: 20, message: "git log"});
                let gitLogCmd = `git log -S${escapeShellArg(text)} -- ${escapeShellArg(document.uri.fsPath)}`;
                let cwd = path.dirname(document.uri.fsPath);
                let {stdout: gitLogStdOut} = await exec(gitLogCmd, {cwd});
                if (!gitLogStdOut) {
                    vscode.window.showWarningMessage('No history found for the selected text');
                    return
                }

                if (token.isCancellationRequested) {
                    return
                }
                progress.report({increment: 20, message: "git show"});
                let shaArr = parseCommitSHAs(gitLogStdOut);
                let gitShowResults = await Promise.all(shaArr.map(async (s) => {
                    let gitShowCmd = `git show ${s} -- "${document.uri.fsPath}"`;
                    let {stdout: gitShowStdOut} = await exec(gitShowCmd, {cwd});
                    return {
                        sha: s,
                        stdout: gitShowStdOut
                    };
                }));

                let entryTemplate = new PromptTemplate({
                    template: entryPrompt,
                    inputVariables: ['code_text'],
                });

                let formattedEntryPrompt = await entryTemplate.format({
                    code_text: text
                });

                if (token.isCancellationRequested) {
                    return
                }
                progress.report({increment: 20, message: "PR API Information"});
                let formattedCommitPrompts = await Promise.all(gitShowResults.map(async showRes => {
                    let commitTemplate = new PromptTemplate({
                        template: commitPrompt,
                        inputVariables: ['show_text', 'pr_title', 'pr_body', 'pr_url'],
                    });

                    let workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    let {stdout: repoUrl} = await exec('git config --get remote.origin.url', {cwd: workspaceFolder});
                    let {owner, repo} = getRepoInfo(repoUrl);
                    let pullData = await getPullsForCommit(owner, repo, showRes.sha);
                    let {title = "none found", body = "none found", url = "none found"} = pullData || {};

                    return await commitTemplate.format({
                        show_text: showRes.stdout,
                        pr_title: title,
                        pr_body: body,
                        pr_url: url
                    });
                }));

                if (token.isCancellationRequested) {
                    return
                }
                progress.report({increment: 20, message: "LLM Prompt"});
                let llm = new ChatOpenAI({
                    openAIApiKey: openAIApiKey,
                    temperature: temperature,
                    modelName: modelName,
                    maxTokens: maxTokens,
                    maxRetries: 5,
                });
                let response = await llm.call([new SystemMessage(formattedEntryPrompt), ...formattedCommitPrompts.map(p => {
                    return new SystemMessage(p)
                }), new SystemMessage(outputPrompt)]);

                if (token.isCancellationRequested) {
                    return
                }
                progress.report({increment: 20, message: "Complete"});
                let panel = vscode.window.createWebviewPanel(
                    'showSelection1',
                    'Code Inspection',
                    vscode.ViewColumn.Beside,
                    {}
                );

                let cleanResponse = response.content.replace(/"""/g, '');
                let responseContentAsHTML = marked(cleanResponse);
                panel.webview.html = `<html><body>${responseContentAsHTML}</body></html>`;
            });
        } catch (err) {
            vscode.window.showErrorMessage(`error: ${err}`);
            console.error(`error: ${err}`);
        }
    } else {
        vscode.window.showInformationMessage('No active editor!');
    }
}

async function isGitRepo(dir) {
    try {
        await exec('git rev-parse --is-inside-work-tree', {cwd: dir});
        return true;
    } catch (e) {
        return false;
    }
}

async function getPullsForCommit(owner, repo, sha) {
    let headers = {
        'User-Agent': 'node.js',
        'Accept': 'application/vnd.github.groot-preview+json'
    };
    if (gitPAT) {
        headers['Authorization'] = 'Bearer ' + gitPAT;
    }

    let url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/pulls`;
    try {
        const response = await axios.get(url, {headers: headers});
        let pulls = response.data;
        let simplifiedPulls = pulls.map(pull => ({title: pull.title, body: pull.body, url: pull.html_url}));
        return simplifiedPulls[0];
    } catch (error) {
        throw error;
    }
}

function getSecrets(config) {
    let openAIApiKey;
    let gitPAT;

    openAIApiKey = process.env.OPENAI_API_KEY || config.get('openAI.apiKey');
    gitPAT = process.env.GIT_PAT || config.get('git.accessToken');

    return {openAIApiKey, gitPAT};
}

function escapeShellArg(arg) {
    return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

function parseCommitSHAs(gitLogOutput) {
    let commitRegex = /commit (\b[0-9a-f]{5,40}\b)/g;
    let matches = gitLogOutput.match(commitRegex);

    if (matches) {
        return matches.map(match => match.split(' ')[1]);
    } else {
        return [];
    }
}

function getRepoInfo(repoUrl) {
    repoUrl = repoUrl.toString().trim();
    let repoPath = new URL(repoUrl).pathname;
    // eslint-disable-next-line no-unused-vars
    let [_, owner, repo] = repoPath.split('/');
    let repoName = repo.replace(/\.git$/, '');

    return {owner, repo: repoName};
}

function deactivate() {
}

module.exports = {
    activate,
    deactivate,
    escapeShellArg,
    parseCommitSHAs,
    getRepoInfo
}
