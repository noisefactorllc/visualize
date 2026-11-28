// SPDX-License-Identifier: MIT
/**
 * An identifier named like an inherited Object property lexes as IDENT.
 *
 * The engine's keyword table used to be read with a plain property lookup,
 * so a lexeme inherited from Object.prototype ('toString', 'valueOf',
 * 'constructor', 'hasOwnProperty') matched the table through inheritance
 * and lexed with an inherited function as its token type instead of a
 * token type name. Visualize renders any program a user types or loads
 * from a share link, and its session agent reads token streams from the
 * same lexer, so a program that binds such a name
 * (let constructor = vec3(0, 0, 0)) failed with a confusing diagnostic
 * instead of compiling. The engine now reads the table with
 * Object.hasOwn. This pins that contract at the product boundary, against
 * the engine core this app actually downloads from the CDN: an inherited
 * name lexes as an identifier, a bound name lexes as IDENT at its binding
 * and at its use, a prototype-property name after a dot still lexes as a
 * member segment, and the reserved words still lex as keywords.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal, routeEngineLocal } from './handfishLocal.js'
installHandfishLocal(test)

test('inherited-property names lex as identifiers', async ({ page }) => {
    await routeEngineLocal(page)
    await page.goto('/')
    const results = await page.evaluate(async () => {
        const { lex } = await import('/js/noisemaker/bundle.js')
        const failures = []
        const check = (name, actual, expected) => {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                failures.push({ name, actual: JSON.stringify(actual), expected: JSON.stringify(expected) })
            }
        }

        // An inherited name lexes as an identifier token.
        for (const name of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__']) {
            check(`bare ${name}`, lex(name).map(token => token.type), ['IDENT', 'EOF'])
        }

        // A bound name is an identifier at its binding and at its use.
        const program = 'let constructor = vec3(0, 0, 0)\nmedia(constructor).write(o0)'
        check('bound constructor', lex(program).filter(token => token.lexeme === 'constructor').map(token => token.type), ['IDENT', 'IDENT'])

        // A prototype-property name after a dot is still a member segment.
        check('member segment', lex('oscKind.toString').map(token => token.type), ['IDENT', 'DOT', 'IDENT', 'EOF'])

        // The reserved words still lex as keywords.
        check('reserved words', lex('let render write write3d true false if elif else break continue return search subchain').map(token => token.type), [
            'LET', 'RENDER', 'WRITE', 'WRITE3D', 'TRUE', 'FALSE', 'IF', 'ELIF',
            'ELSE', 'BREAK', 'CONTINUE', 'RETURN', 'SEARCH', 'SUBCHAIN', 'EOF',
        ])

        return { failures }
    })
    expect(results.failures, JSON.stringify(results)).toEqual([])
})
