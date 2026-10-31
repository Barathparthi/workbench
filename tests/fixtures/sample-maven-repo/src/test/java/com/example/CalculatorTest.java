package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

class CalculatorTest {
  @Test
  void adds() {
    assertEquals(5, Calculator.add(2, 3));
  }

  @Test
  void divides() {
    assertEquals(3, Calculator.divide(9, 3));
  }

  @Test
  @Tag("slow")
  void dividingByZeroThrows() {
    assertThrows(ArithmeticException.class, () -> Calculator.divide(1, 0));
  }

  @Test
  void addsNegativesFailsOnPurpose() {
    assertEquals(-6, Calculator.add(-2, -3)); // line 29: the one failure
  }

  @Test
  @Disabled("needs the lab network")
  void needsNetwork() {}
}
