"""Prepared only. Root must approve the merged main revision before invocation."""
import sys
from window_files import prepare

if __name__ == '__main__':
    assert len(sys.argv) == 3 and sys.argv[1] == '--prepare', 'Explicit --prepare <verified-main-revision> required'
    prepare(sys.argv[2])
