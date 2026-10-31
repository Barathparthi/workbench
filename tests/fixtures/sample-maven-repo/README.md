# Sample Maven project

The QE runner's Maven fixture (PHASE_11 P11.6): 5 tests in `CalculatorTest` — 3 pass, 1 fails on a known line, 1 is
disabled (skipped). Running it needs Maven and access to Maven Central for the plugins and JUnit; the integration test
that uses it runs only with `QE_TEST_MAVEN=1`.
