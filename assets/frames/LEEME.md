# Marcos personalizados del cliente

Los tres marcos que trae KuvaConnect (`kuva-classic`, `kuva-noir`, `kuva-polaroid`)
están dibujados por código. Cuando llegue el arte real del diseñador, se enchufa
aquí **sin tocar el código**.

## Qué pedirle al diseñador

Dos PNG con **transparencia en el hueco de la foto**:

| Archivo         | Tamaño        | Formato final |
|-----------------|---------------|---------------|
| `portrait.png`  | 1200 × 1800px | 10×15 cm vertical a 300 dpi |
| `landscape.png` | 1800 × 1200px | 10×15 cm horizontal a 300 dpi |

Dos advertencias que vale la pena pasarle al diseñador:

- **El hueco debe ser 100% transparente**, no blanco. Ahí va la foto.
- Dejar ~3 mm (35 px) de margen de seguridad en el borde: las DNP recortan un
  poquito y no queremos perder el logo.

## Cómo instalarlo

1. Crear una carpeta con el id del marco, por ejemplo `assets/frames/cliente-acme/`.
2. Meter ahí `portrait.png` y `landscape.png`.
3. Crear `frame.json` en esa misma carpeta:

```json
{
  "name": "Acme 2026",
  "description": "Marco oficial del cliente.",
  "paper": "#FFFFFF",
  "portrait": {
    "canvas": { "w": 1200, "h": 1800 },
    "window": { "x": 76, "y": 76, "w": 1048, "h": 1384, "radius": 0 }
  },
  "landscape": {
    "canvas": { "w": 1800, "h": 1200 },
    "window": { "x": 76, "y": 76, "w": 1648, "h": 898, "radius": 0 }
  }
}
```

`window` son las coordenadas del hueco **en píxeles**, medidas desde la esquina
superior izquierda del PNG. Se sacan en un segundo con la herramienta de
selección de Photoshop o Figma.

4. Reiniciar el servidor. El marco aparece solo en **Panel → Ajustes → Marco de
   impresión**, con su vista previa.

5. Si ya habías recibido fotos con el marco anterior, usa el botón
   **"Regenerar todas las impresiones con este marco"**.
