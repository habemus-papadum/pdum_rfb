"""Example tests for rfb."""

from pdum import rfb


def test_version():
    """Test that the package has a version."""
    assert hasattr(rfb, "__version__")
    assert isinstance(rfb.__version__, str)
    assert len(rfb.__version__) > 0


def test_import():
    """Test that the package can be imported."""
    assert rfb is not None

