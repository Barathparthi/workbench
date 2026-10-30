import pytest

from calculator import add, divide


def test_add():
    assert add(2, 3) == 5


def test_divide():
    assert divide(9, 3) == 3


@pytest.mark.slow
def test_divide_by_zero():
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)


def test_add_negative_fails_on_purpose():
    assert add(-2, -3) == -6  # line 21: the one failure


@pytest.mark.skip(reason="needs the lab network")
def test_needs_network():
    pass
