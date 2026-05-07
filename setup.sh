#!/bin/bash

# ============================================
# SCRIPT DE SETUP AUTOMÁTICO - BOOKREADER
# ============================================
# Ejecutar: bash setup.sh
# Este script automatiza:
# - Creación de .env.local
# - Instalación de dependencias
# - Configuración inicial

echo "========================================="
echo "  📚 BOOKREADER - Setup Automático"
echo "========================================="
echo ""

# Verificar si Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "❌ Node.js no está instalado"
    echo "Descárgalo desde: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js encontrado: $(node --version)"
echo ""

# Verificar si git está instalado
if ! command -v git &> /dev/null; then
    echo "❌ Git no está instalado"
    echo "Descárgalo desde: https://git-scm.com/"
    exit 1
fi

echo "✅ Git encontrado: $(git --version)"
echo ""

# Crear .env.local si no existe
if [ ! -f .env.local ]; then
    echo "📝 Creando archivo .env.local..."
    cp .env.example .env.local
    echo "✅ Archivo .env.local creado"
    echo ""
    echo "⚠️  IMPORTANTE: Debes editar .env.local con tus credenciales de Firebase"
    echo "   Ubica el archivo en la raíz del proyecto y rellena los valores"
    echo ""
else
    echo "✅ .env.local ya existe"
fi

# Instalar dependencias
echo "📦 Instalando dependencias..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependencias instaladas correctamente"
else
    echo "❌ Error al instalar dependencias"
    exit 1
fi

echo ""
echo "========================================="
echo "  ✅ SETUP COMPLETADO"
echo "========================================="
echo ""
echo "Próximos pasos:"
echo ""
echo "1. Edita .env.local con tus credenciales de Firebase"
echo "   (Obtén las credenciales de Firebase Console → Project Settings)"
echo ""
echo "2. Inicia la app con:"
echo "   npm start"
echo ""
echo "3. La app se abrirá en http://localhost:3000"
echo ""
echo "========================================="
echo ""
