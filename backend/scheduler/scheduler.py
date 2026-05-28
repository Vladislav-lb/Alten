from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone


JobHandler = Callable[[], Awaitable[None]]


@dataclass
class SchedulerJob:
    name: str
    interval_seconds: int
    handler: JobHandler
    run_immediately: bool = False
    next_run: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class EmsScheduler:
    """Small async scheduler for edge deployments.

    Replace with APScheduler, Celery Beat, or cloud tasks when the backend grows.
    """

    def __init__(self) -> None:
        self.jobs: list[SchedulerJob] = []
        self._stop = asyncio.Event()

    def add_job(self, job: SchedulerJob) -> None:
        if not job.run_immediately:
            job.next_run = datetime.now(timezone.utc) + timedelta(seconds=job.interval_seconds)
        self.jobs.append(job)

    async def run_forever(self) -> None:
        while not self._stop.is_set():
            now = datetime.now(timezone.utc)
            due = [job for job in self.jobs if job.next_run <= now]
            for job in due:
                await job.handler()
                job.next_run = now + timedelta(seconds=job.interval_seconds)
            await asyncio.sleep(1)

    def stop(self) -> None:
        self._stop.set()
