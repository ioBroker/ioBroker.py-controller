# ioBroker.py-controller

Verwaltet Python-**Umgebungen** für Python-Adapter — Interpreter beschaffen,
venv je Adapter anlegen und reparieren, Pakete installieren, Zustand anzeigen.

> **Status: 0.0.1, Gerüst.** Noch nicht lauffähig als Adapter.

## Der Zuschnitt

Dieser Adapter verwaltet **keine Prozesse**. Die Prozesshoheit bleibt beim
js-controller: er startet, überwacht und stoppt Python-Adapter genauso wie
Node-Adapter. Das ist möglich, weil sein Startpfad weit sprachneutraler ist als
er aussieht — der Stopp läuft über den `sigKill`-State, `alive`/`uptime`
schreibt der Adapter selbst, stdout wird ohnehin verworfen, und der IPC-Kanal
wird nirgends benutzt. Node-spezifisch sind im Wesentlichen nur die beiden
`cp.fork`-Aufrufstellen und die Auflösung der Startdatei.

Ein zweiter Prozess-Supervisor würde Neustart-Backoff, Absturzzählung und
Statusmeldung ein zweites Mal implementieren — mit eigenen Fehlern, und ohne
dass `iobroker start`, die Instanzliste oder Multihost etwas davon mitbekämen.

## Der Vertrag zum js-controller

Genau eine Richtung, damit es keine Verschränkung gibt:

> Der js-controller startet eine Python-Instanz nur, wenn ihr venv unter
> `iobroker-data/py/<name>/` existiert und zur geforderten Paketversion passt.
> Fehlt oder hinkt es, wird nicht gestartet, sondern ein Fehlerzustand gesetzt.
> Der py-controller beobachtet den Zustand, baut die Umgebung und stößt den
> Neustart an.

Damit muss der Kern nichts über `pip`, `uv` oder Paketauflösung wissen — nur,
ob ein Verzeichnis da ist.

## Verteilung von Python-Adaptern

Ein Python-Adapter wird trotzdem als npm-Paket ausgeliefert: `io-package.json`,
`admin/jsonConfig.json` und ein Verzeichnis `python/` mit `pyproject.toml`.
Damit funktionieren Repository, Repo-Checker, `iobroker add`, Admin-Update und
Backup ohne eine einzige Änderung.

Der einzige neue Marker ist `common.runtime: "python"`. Der js-controller
entscheidet daran, wie er startet; dieser Adapter, wofür er ein venv baut.
Fehlt das Feld, läuft alles exakt wie bisher.

## Verwandt

- [iobroker-python](https://github.com/ioBroker/iobroker-python) — das SDK, mit
  dem Python-Adapter geschrieben werden.

## Lizenz

MIT
