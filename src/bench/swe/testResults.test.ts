import { expect, test } from 'bun:test'
import { parseTestOutcomes, pytestInvocation, pytestShellCommand } from './testResults.ts'

// Captured from a real `pytest -v --no-header -rA` run (pytest 9.0.3) against
// three sample tests (one pass, one assertion failure, one uncaught
// exception) — verified by hand before writing this test, not guessed from
// pytest's documentation.
const REAL_PYTEST_OUTPUT = `============================= test session starts =============================
collecting ... collected 3 items

test_sample.py::test_pass PASSED                                         [ 33%]
test_sample.py::test_fail FAILED                                         [ 66%]
test_sample.py::test_error FAILED                                        [100%]

================================== FAILURES ===================================
__________________________________ test_fail __________________________________

    def test_fail():
>       assert 1 == 2
E       assert 1 == 2

test_sample.py:5: AssertionError
_________________________________ test_error __________________________________

    def test_error():
>       raise RuntimeError("boom")
E       RuntimeError: boom

test_sample.py:8: RuntimeError
=================================== PASSES ====================================
=========================== short test summary info ===========================
PASSED test_sample.py::test_pass
FAILED test_sample.py::test_fail - assert 1 == 2
FAILED test_sample.py::test_error - RuntimeError: boom
========================= 2 failed, 1 passed in 0.11s =========================
`

test('parseTestOutcomes reads the short test summary info section from real pytest output', () => {
  const outcomes = parseTestOutcomes(REAL_PYTEST_OUTPUT)
  expect(outcomes.get('test_sample.py::test_pass')).toBe('PASSED')
  expect(outcomes.get('test_sample.py::test_fail')).toBe('FAILED')
  expect(outcomes.get('test_sample.py::test_error')).toBe('FAILED')
  expect(outcomes.size).toBe(3)
})

test('parseTestOutcomes handles a parametrized test id containing brackets', () => {
  const output = 'short test summary info\nPASSED test_math.py::test_add[1-2-3]\nFAILED test_math.py::test_add[2-2-5] - assert 4 == 5\n'
  const outcomes = parseTestOutcomes(output)
  expect(outcomes.get('test_math.py::test_add[1-2-3]')).toBe('PASSED')
  expect(outcomes.get('test_math.py::test_add[2-2-5]')).toBe('FAILED')
})

test('parseTestOutcomes returns an empty map for output with no summary section', () => {
  expect(parseTestOutcomes('no test summary here').size).toBe(0)
})

test('pytestInvocation splits into a real argv — never a shell string a test id\'s own quoting could corrupt', () => {
  const { executable, args } = pytestInvocation(['test_a.py::test_one', 'test_b.py::test_two[x]'])
  expect(executable).toBe('python')
  expect(args).toEqual(['-m', 'pytest', 'test_a.py::test_one', 'test_b.py::test_two[x]', '-v', '--no-header', '-rA'])
})

test('pytestInvocation honors a custom test command prefix, including a multi-word one', () => {
  expect(pytestInvocation(['t::x'], 'python3 -m pytest')).toEqual({ executable: 'python3', args: ['-m', 'pytest', 't::x', '-v', '--no-header', '-rA'] })
})

test('pytestShellCommand single-quotes each argument for sh -c, escaping an embedded quote', () => {
  expect(pytestShellCommand(['test_a.py::test_one'])).toBe("'python' '-m' 'pytest' 'test_a.py::test_one' '-v' '--no-header' '-rA'")
  // A test id containing a literal single quote (rare, but parametrized string params can) must not break out of its quoting.
  expect(pytestShellCommand(["test_a.py::test['x']"])).toContain(String.raw`'test_a.py::test['\''x'\'']'`)
})
