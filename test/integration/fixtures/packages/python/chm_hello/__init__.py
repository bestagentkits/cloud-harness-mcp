import sys


def main():
    if sys.argv[1:] == ["--version"]:
        print("chm-hello-py 1.0.0")
        return 0
    print("hello from chm-hello-py")
    return 0
