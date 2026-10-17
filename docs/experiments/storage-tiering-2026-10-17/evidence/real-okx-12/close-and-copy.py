"""Prepared only. Root may invoke once after the v5 run formally settles."""
import sys
from window_files import close_and_copy

if __name__ == '__main__':
    assert sys.argv[1:] == ['--closed-copy'], 'Explicit --closed-copy required'
    close_and_copy()
