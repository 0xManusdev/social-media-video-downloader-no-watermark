"""
Simplified async download queue manager.
Semaphores are created on first access within the running event loop.
"""
import asyncio
from bot.config import MAX_CONCURRENT_DOWNLOADS

_MAX_PER_USER = 1

# Created lazily on first use (must be inside a running event loop)
_global_sem: asyncio.Semaphore | None = None
_user_sems: dict[int, asyncio.Semaphore] = {}
_active_count: int = 0


def _global() -> asyncio.Semaphore:
    global _global_sem
    if _global_sem is None:
        _global_sem = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)
    return _global_sem


def _user(user_id: int) -> asyncio.Semaphore:
    if user_id not in _user_sems:
        _user_sems[user_id] = asyncio.Semaphore(_MAX_PER_USER)
    return _user_sems[user_id]


async def acquire(user_id: int) -> None:
    global _active_count
    await _user(user_id).acquire()
    await _global().acquire()
    _active_count += 1


async def release(user_id: int) -> None:
    global _active_count
    _user(user_id).release()
    _global().release()
    _active_count = max(0, _active_count - 1)


def active_downloads() -> int:
    return _active_count


def queue_depth() -> int:
    val = getattr(_global_sem, "_value", MAX_CONCURRENT_DOWNLOADS)
    return max(0, MAX_CONCURRENT_DOWNLOADS - val)
