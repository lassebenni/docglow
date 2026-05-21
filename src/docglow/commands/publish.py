"""Publish command for docglow CLI."""

from pathlib import Path

import click


@click.command()
@click.option(
    "--token",
    envvar="DOCGLOW_TOKEN",
    default=None,
    help="API token (or set DOCGLOW_TOKEN env var)",
)
@click.option("--project-dir", type=click.Path(exists=True, path_type=Path), default=".")
@click.option("--target-dir", type=click.Path(path_type=Path), default=None)
@click.option(
    "--api-url",
    default=None,
    help="Override the API base URL (e.g. https://app-staging.docglow.com). "
    "Takes precedence over DOCGLOW_API_URL and ~/.docglow/config.json.",
)
@click.option("--no-wait", is_flag=True, help="Don't wait for processing to complete")
@click.option("--verbose", is_flag=True)
def publish(
    token: str | None,
    project_dir: Path,
    target_dir: Path | None,
    api_url: str | None,
    no_wait: bool,
    verbose: bool,
) -> None:
    """Publish documentation to docglow.com."""
    from docglow.cli import _setup_logging, console

    _setup_logging(verbose)

    try:
        from docglow.cloud.config import load_cloud_config
        from docglow.cloud.publish import run_publish
    except ImportError:
        console.print(
            "[bold red]Error:[/bold red] Cloud features require httpx. "
            "Install with: [bold]pip install docglow\\[cloud][/bold]"
        )
        raise SystemExit(1)

    from dataclasses import replace

    config = load_cloud_config()
    if token:
        config = replace(config, token=token)
    if api_url:
        config = replace(config, api_base_url=api_url)

    if not config.token:
        console.print(
            "[bold red]Error:[/bold red] No API token found. "
            "Set DOCGLOW_TOKEN env var or run [bold]docglow login[/bold]."
        )
        raise SystemExit(1)

    try:
        from docglow.cloud.client import CloudApiError

        result = run_publish(config, project_dir, target_dir, no_wait=no_wait)
        status = result.get("status", "unknown")

        if status == "complete":
            site_url = result.get("site_url", "")
            health_score = result.get("health_score")
            console.print("\n[bold green]Published successfully![/bold green]")
            if site_url:
                console.print(f"  Site: {site_url}")
            if health_score is not None:
                console.print(f"  Health score: {health_score}")
        else:
            publish_id = result.get("publish_id", "")
            console.print("\n[bold blue]Upload complete[/bold blue]")
            console.print(f"  Publish ID: {publish_id}")
            console.print(f"  Status: {status}")
    except FileNotFoundError as e:
        console.print(f"[bold red]Error:[/bold red] {e}")
        raise SystemExit(1) from e
    except CloudApiError as e:
        console.print(f"[bold red]Error:[/bold red] {e}")
        raise SystemExit(1) from e
