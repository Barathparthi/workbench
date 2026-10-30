import os
import sys

# The project folder, so the tests import calculator.py wherever pytest is started.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
