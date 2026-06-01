from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

TARGET_URL = "https://www.walmart.com"  # tu DNS lo redirige al servidor del lab

def main():
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--ignore-certificate-errors")  # por si el cert del lab no es válido
    # options.add_argument("--headless")  # descomenta si no quieres ver el navegador

    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    wait = WebDriverWait(driver, 15)

    try:
        driver.get(TARGET_URL)
        print("[*] Página cargada")

        # Paso 1: clic en el icono de accesibilidad (el SVG con círculo #424257)
        # Busca el contenedor clickable que tenga ese SVG
        accessibility_btn = wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "circle[fill='#424257']"))
        )
        btn = driver.execute_script(
            "return arguments[0].closest('button, [role=\"button\"], a, div[onclick], [tabindex]')",
            accessibility_btn
        )
        driver.execute_script("arguments[0].click();", btn)
        print("[*] Icono de accesibilidad clickado")

        # Paso 2: esperar a que aparezca "Press again" y clickarlo
        press_again = wait.until(
            EC.element_to_be_clickable((By.ID, "phdBrrXLjVmIxbK"))
        )
        time.sleep(0.5)  # espera a que termine la animación CSS (4178ms definida en el elemento)
        driver.execute_script("arguments[0].click();", press_again)
        print("[*] 'Press again' clickado")

        print("[+] CAPTCHA superado — dentro del sitio")
        time.sleep(4)

    finally:
        driver.quit()

if __name__ == "__main__":
    main()
