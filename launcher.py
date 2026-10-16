import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path

from lan_server import create_server


def get_app_directory():
    bundle_directory = getattr(sys, "_MEIPASS", None)
    if bundle_directory:
        return Path(bundle_directory)
    return Path(__file__).resolve().parent


def main():
    app_directory = get_app_directory()
    server = create_server(app_directory)
    port = server.server_port
    app_url = f"http://127.0.0.1:{port}/"
    lan_url = f"http://{server.lan_address}:{port}/"
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    window = tk.Tk()
    window.title("Y-Vision")
    window.geometry("420x250")
    window.resizable(False, False)
    window.configure(bg="#f4f1e9")

    tk.Label(
        window,
        text="Y-Vision",
        bg="#f4f1e9",
        fg="#20211e",
        font=("Segoe UI", 19, "bold"),
    ).pack(anchor="w", padx=24, pady=(20, 2))
    tk.Label(
        window,
        text="Y-Vision ativo. Abra no navegador deste PC ou na LAN.",
        bg="#f4f1e9",
        fg="#65665e",
        font=("Segoe UI", 9),
    ).pack(anchor="w", padx=25, pady=(0, 14))

    tk.Label(
        window,
        text="Endereço LAN para o outro computador:",
        bg="#f4f1e9",
        fg="#65665e",
        font=("Segoe UI", 9, "bold"),
    ).pack(anchor="w", padx=25, pady=(0, 5))

    url_entry = tk.Entry(
        window,
        bg="#fffefa",
        fg="#44453f",
        relief="solid",
        bd=1,
        font=("Segoe UI", 9),
    )
    url_entry.insert(0, lan_url)
    url_entry.configure(state="readonly")
    url_entry.pack(fill="x", padx=24, ipady=7)

    def open_app():
        webbrowser.open_new_tab(app_url)

    tk.Button(
        window,
        text="Abrir Y-Vision",
        command=open_app,
        bg="#ef6a36",
        fg="white",
        activebackground="#ca4d22",
        activeforeground="white",
        relief="flat",
        cursor="hand2",
        font=("Segoe UI", 10, "bold"),
    ).pack(fill="x", padx=24, pady=(13, 0), ipady=7)

    tk.Label(
        window,
        text="Execute o Y-Vision nos dois PCs e informe este endereço ao convidado.",
        bg="#f4f1e9",
        fg="#77786f",
        font=("Segoe UI", 8),
    ).pack(anchor="w", padx=25, pady=(8, 0))

    def close_app():
        server.shutdown()
        server.server_close()
        window.destroy()

    window.protocol("WM_DELETE_WINDOW", close_app)
    window.after(500, open_app)
    window.mainloop()


if __name__ == "__main__":
    main()