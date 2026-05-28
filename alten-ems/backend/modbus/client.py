from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class RegisterTransport(Protocol):
    async def read_holding_registers(self, address: int, count: int, unit: int = 1) -> list[int]:
        ...

    async def write_register(self, address: int, value: int, unit: int = 1) -> None:
        ...


@dataclass(frozen=True)
class BatteryRegisterMap:
    soc: int = 100
    power_kw: int = 102
    status: int = 104
    command_mode: int = 200
    command_power_kw: int = 201
    scale: float = 10.0


class ModbusBatteryClient:
    """Protocol adapter for Modbus TCP or RS485 transports."""

    def __init__(self, transport: RegisterTransport, unit: int = 1, register_map: BatteryRegisterMap | None = None) -> None:
        self.transport = transport
        self.unit = unit
        self.registers = register_map or BatteryRegisterMap()

    async def read_telemetry(self) -> dict[str, float | int]:
        values = await self.transport.read_holding_registers(self.registers.soc, 5, unit=self.unit)
        return {
            "soc": values[0] / self.registers.scale,
            "power_kw": _signed_16(values[2]) / self.registers.scale,
            "status": values[4],
        }

    async def write_command(self, mode: str, power_kw: float) -> None:
        mode_code = {"idle": 0, "charge": 1, "discharge": 2}.get(mode)
        if mode_code is None:
            raise ValueError(f"Unsupported Modbus command mode: {mode}")
        await self.transport.write_register(self.registers.command_mode, mode_code, unit=self.unit)
        await self.transport.write_register(self.registers.command_power_kw, int(power_kw * self.registers.scale), unit=self.unit)


def _signed_16(value: int) -> int:
    return value - 65536 if value & 0x8000 else value
