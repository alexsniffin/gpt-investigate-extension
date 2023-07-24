const assert = require('assert');
const vscode = require('vscode');
const { escapeShellArg, parseCommitSHAs, getRepoInfo } = require('../../extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');
	test('should return the argument wrapped in double quotes', () => {
        const input = 'hello';
        const output = escapeShellArg(input);
        assert.strictEqual(output, '"hello"');
    });

    test('should escape double quote characters', () => {
        const input = 'hello "world"';
        const output = escapeShellArg(input);
        assert.strictEqual(output, '"hello \\"world\\""');
    });

    test('should escape backslash characters', () => {
        const input = 'hello\\world';
        const output = escapeShellArg(input);
        assert.strictEqual(output, '"hello\\\\world"');
    });

    test('should escape dollar sign characters', () => {
        const input = 'hello$world';
        const output = escapeShellArg(input);
        assert.strictEqual(output, '"hello\\$world"');
    });

    test('should escape backtick characters', () => {
        const input = 'hello`world';
        const output = escapeShellArg(input);
        assert.strictEqual(output, '"hello\\`world"');
    });

    test('should return an array of commit SHAs', function() {
        const gitLogOutput = `
            commit e93c5163316f89bfb1e7d9ab23ca2e25604a5290
            Author: John Doe <johnd@gmail.com>
            Date:   Mon Mar 17 21:52:11 2008 -0700
        `;
        const result = parseCommitSHAs(gitLogOutput);
        assert.deepStrictEqual(result, ['e93c5163316f89bfb1e7d9ab23ca2e25604a5290']);
    });

    test('should return an empty array if no commit SHAs are present', function() {
        const gitLogOutput = `
            Author: John Doe <johnd@gmail.com>
            Date:   Mon Mar 17 21:52:11 2008 -0700
        `;
        const result = parseCommitSHAs(gitLogOutput);
        assert.deepStrictEqual(result, []);
    });

    test('should handle multiple commit SHAs', function() {
        const gitLogOutput = `
            commit e93c5163316f89bfb1e7d9ab23ca2e25604a5290
            Author: John Doe <johnd@gmail.com>
            Date:   Mon Mar 17 21:52:11 2008 -0700

            commit e93c5163316f89bfb1e7d9ab23ca2e25604a5291
            Author: John Doe <johnd@gmail.com>
            Date:   Mon Mar 17 21:52:11 2008 -0700
        `;
        const result = parseCommitSHAs(gitLogOutput);
        assert.deepStrictEqual(result, ['e93c5163316f89bfb1e7d9ab23ca2e25604a5290', 'e93c5163316f89bfb1e7d9ab23ca2e25604a5291']);
    });

    test('should parse owner and repo from a GitHub HTTPS URL', function() {
        const repoUrl = 'https://github.com/owner/repo.git';
        const result = getRepoInfo(repoUrl);
        assert.deepStrictEqual(result, { owner: 'owner', repo: 'repo' });
    });

    test('should parse owner and repo without .git in the URL', function() {
        const repoUrl = 'https://github.com/owner/repo';
        const result = getRepoInfo(repoUrl);
        assert.deepStrictEqual(result, { owner: 'owner', repo: 'repo' });
    });

    test('should handle URLs with additional path segments', function() {
        const repoUrl = 'https://github.com/owner/repo/extra/path/segments';
        const result = getRepoInfo(repoUrl);
        assert.deepStrictEqual(result, { owner: 'owner', repo: 'repo' });
    });
});
