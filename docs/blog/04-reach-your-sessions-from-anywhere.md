# Check on your agents from your phone

*Agenv can open a tunnel to your running workspace, and now the desktop app keeps running while it does.*

Long agent runs are the reason you walk away from the desk. The problem is knowing what happened while you were gone.

## Start a tunnel from the running app

You don't need to launch anything differently. In any running Agenv, open the globe panel (🌐), check that the port is the one in your browser's address bar (since 1.10.6 it fills itself in), and click **Start HTTP Tunnel**. You get a public link with your access token in it. Open it on your phone and you see the same sessions, with the same terminals.

You need [ngrok](https://ngrok.com) installed and signed in once (`ngrok config add-authtoken ...`).

## The desktop app stays alive for you

Until 1.10.7, closing the desktop window quit the app, and the tunnel with it. Now, if a tunnel is up when you close the last window, Agenv keeps running in the system tray. "Open Agenv" brings the window back; "Quit" stops everything. If you stop the tunnel, the hidden app quits by itself. With no tunnel, closing the window behaves as it always did.

## Be careful: this is your terminal

Anyone with the link controls your sessions. Use the controls on the panel:

- **IP allow-list**: only listed addresses may connect.
- **Read-only**: tunnel visitors can watch terminals but can't type, and writes to sessions, files, git, agents and routines are blocked.
- **Rotate token**: invalidates every existing link at once.

A good default for checking in from a phone is read-only plus your phone's address. Turn the tunnel off when you're done; stopping it is one click.
