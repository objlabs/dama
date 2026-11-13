"""Measure idle service memory and CPU on the Docker Engine's Linux host."""

import argparse
import json
import re
import statistics
import subprocess
import time
import uuid


MIB = 1024 ** 2
SIZE_FACTORS = {"B": 1, "KiB": 1024, "MiB": MIB, "GiB": 1024 ** 3}
READINESS_CHECK = """
async function waitForHealth(name) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`http://${name}:3000/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not pass its health check`);
}
Promise.all(process.argv.slice(1).map(waitForHealth)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
"""


def docker(*args, check=True):
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=90
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or f"docker {args[0]} failed")
    if not check and result.returncode:
        print(result.stderr.strip(), flush=True)
    return result.stdout.strip()


def memory_mib(value):
    used = value.split(" / ", 1)[0]
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)", used)
    if not match:
        raise ValueError(f"Unexpected Docker memory value: {used}")
    amount, unit = match.groups()
    return float(amount) * SIZE_FACTORS[unit] / MIB


def sample(observer, services):
    memory = docker("exec", observer, "cat", "/proc/meminfo")
    fields = {name: int(value) for name, value in re.findall(
        r"^(MemTotal|MemAvailable):\s+(\d+) kB$", memory, re.MULTILINE
    )}
    stats = []
    if services:
        rows = docker("stats", "--no-stream", "--format", "{{json .}}", *services)
        stats = [json.loads(row) for row in rows.splitlines()]
        if len(stats) != len(services):
            raise RuntimeError("Docker stats returned an incomplete sample")
    return {
        "host_used_mib": (fields["MemTotal"] - fields["MemAvailable"]) / 1024,
        "service_memory_mib": sum(memory_mib(row["MemUsage"]) for row in stats),
        "service_cpu_percent": sum(float(row["CPUPerc"].rstrip("%")) for row in stats),
    }


def benchmark(image, levels, samples):
    # Resolve the tag once so every replica and the observer use the same image.
    image_id = docker("image", "inspect", "--format", "{{.Id}}", image)
    run_id = f"dama-bench-{uuid.uuid4().hex[:12]}"
    observer = f"{run_id}-observer"
    services = []
    created = []
    network_created = False
    try:
        docker("network", "create", "--internal", run_id)
        network_created = True
        created.append(observer)
        docker("run", "-d", "--name", observer, "--network", run_id,
               "--entrypoint", "sleep", image_id, "infinity")

        for count in [0, *levels, 0]:
            while len(services) < count:
                name = f"{run_id}-{len(services) + 1}"
                created.append(name)
                docker("run", "-d", "--name", name, "--network", run_id,
                       "-e", "PORT=3000", "-e", "DAMA_BASE_PATH=", image_id)
                services.append(name)
            if count == 0 and services:
                docker("rm", "-f", *services)
                created = [observer]
                services.clear()
            if services:
                docker("exec", observer, "node", "-e", READINESS_CHECK, *services)

            time.sleep(4)
            readings = []
            for index in range(samples):
                if index:
                    time.sleep(2)
                readings.append(sample(observer, services))
            medians = {
                metric: round(statistics.median(row[metric] for row in readings), 2)
                for metric in readings[0]
            }
            print(json.dumps({"services": count, **medians, "samples": readings}), flush=True)
    finally:
        if created:
            docker("rm", "-f", *created, check=False)
        if network_created:
            docker("network", "rm", run_id, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="dama-verify-typescript")
    parser.add_argument("--levels", nargs="+", type=int, default=[10, 20])
    parser.add_argument("--samples", type=int, default=5)
    args = parser.parse_args()
    if args.levels != sorted(set(args.levels)) or min(args.levels) < 1:
        parser.error("--levels must be increasing positive integers")
    if args.samples < 1:
        parser.error("--samples must be positive")
    benchmark(args.image, args.levels, args.samples)


if __name__ == "__main__":
    main()
