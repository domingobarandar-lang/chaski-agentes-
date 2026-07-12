// Herramientas del agente de retail: definiciones (para Claude) + ejecución.
// Alcance LIMITADO por diseño: buscar productos, stock, crear/consultar/cancelar pedidos.

const { db, normalizar } = require('../database/supabase');

const TOOL_DEFINITIONS = [
  {
    name: 'buscar_productos',
    description: 'Busca productos del catálogo por texto y/o categoría. Úsala cuando el cliente pregunte qué venden, pida un producto o quiera ver opciones.',
    input_schema: {
      type: 'object',
      properties: {
        consulta:  { type: 'string', description: 'Texto a buscar en nombre/descripción (ej: "almendras", "maní salado", "mix 500 g")' },
        categoria: { type: 'string', description: 'Filtro opcional por categoría (ej: "frutos secos", "mix", "fruta deshidratada")' },
      },
    },
  },
  {
    name: 'consultar_stock',
    description: 'Devuelve stock, precio y unidad de un producto específico. Úsala antes de confirmar un pedido si hay dudas de disponibilidad.',
    input_schema: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Nombre (o parte del nombre) del producto' },
      },
      required: ['producto'],
    },
  },
  {
    name: 'crear_pedido',
    description: 'Crea un pedido con los productos y cantidades confirmados por el cliente. Llamar solo cuando el cliente ya confirmó productos, cantidades y su nombre. Descuenta stock automáticamente.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_cliente: { type: 'string', description: 'Nombre del cliente' },
        items: {
          type: 'array',
          description: 'Productos del pedido',
          items: {
            type: 'object',
            properties: {
              producto: { type: 'string', description: 'Nombre del producto tal como aparece en el catálogo' },
              cantidad: { type: 'number', description: 'Cantidad. Acepta decimales SOLO en productos vendidos por kg (ej: 0.5 = medio kilo); los productos por unidad requieren enteros.' },
            },
            required: ['producto', 'cantidad'],
          },
        },
        direccion: { type: 'string', description: 'Dirección de entrega si el cliente la dio (opcional)' },
        notas:     { type: 'string', description: 'Comentario opcional del cliente' },
        confirmar_duplicado: { type: 'boolean', description: 'Pasa true SOLO si el cliente pidió explícitamente repetir un pedido idéntico al que acaba de crear (por defecto un pedido igual y reciente se rechaza como confirmación repetida).' },
      },
      required: ['nombre_cliente', 'items'],
    },
  },
  {
    name: 'consultar_pedido',
    description: 'Devuelve el último pedido del cliente (se identifica por su teléfono) con su estado y detalle. Úsala cuando pregunte "¿cómo va mi pedido?".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cancelar_pedido',
    description: 'Cancela el último pedido del cliente (solo si aún está en estado "recibido") y repone el stock. Úsala cuando quiera anular su pedido, y también para CAMBIOS: cancelar el pedido anterior y luego crear el nuevo con crear_pedido. Confirma con el cliente antes de llamarla.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Ejecuta una herramienta y retorna un objeto serializable para el tool_result.
 * @param {string} nombre
 * @param {Object} input
 * @param {string} telefono - Teléfono del cliente (identidad de la sesión)
 */
async function ejecutarHerramienta(nombre, input, telefono) {
  switch (nombre) {
    case 'buscar_productos': return buscarProductos(input);
    case 'consultar_stock':  return consultarStock(input);
    case 'crear_pedido':     return crearPedido(input, telefono);
    case 'consultar_pedido': return consultarPedido(telefono);
    case 'cancelar_pedido':  return cancelarPedido(telefono);
    default: return { error: `Herramienta desconocida: ${nombre}` };
  }
}

/**
 * Resuelve un nombre a UN producto del catálogo.
 * @returns {{producto: Object} | {noExiste: true} | {ambiguo: Object[]}}
 */
async function resolverProducto(nombre) {
  const candidatos = await db.productos.buscar(nombre);
  if (!candidatos.length) return { noExiste: true };
  if (candidatos.length === 1) return { producto: candidatos[0] };
  const q = normalizar(nombre).trim();
  const exacto = candidatos.find((p) => normalizar(p.nombre) === q);
  if (exacto) return { producto: exacto };
  const porNombre = candidatos.filter((p) => normalizar(p.nombre).includes(q));
  if (porNombre.length === 1) return { producto: porNombre[0] };
  return { ambiguo: candidatos };
}

// Cuando una búsqueda no encuentra nada, entrega contexto para que el agente
// ofrezca alternativas reales en vez de un "no hay" seco (o inventar).
async function ayudaSinResultados(consulta) {
  const [todos, similares] = await Promise.all([
    db.productos.buscar(),
    consulta ? db.productos.buscarAmplio(consulta) : Promise.resolve([]),
  ]);
  return {
    categorias_disponibles: [...new Set(todos.map((p) => p.categoria).filter(Boolean))],
    sugerencias: similares.slice(0, 5).map((p) => p.nombre),
  };
}

const resumenProducto = (p) => ({
  nombre: p.nombre,
  precio: p.precio,
  unidad: p.unidad,
  stock: p.stock,
});

async function buscarProductos({ consulta, categoria } = {}) {
  const productos = await db.productos.buscar(consulta, categoria);
  if (!productos.length) {
    return {
      resultados: 0,
      mensaje: 'No se encontraron productos para esa búsqueda.',
      ...(await ayudaSinResultados(consulta)),
    };
  }
  return {
    resultados: productos.length,
    productos: productos.map((p) => ({
      nombre: p.nombre,
      descripcion: p.descripcion,
      categoria: p.categoria,
      precio: p.precio,
      unidad: p.unidad,
      stock: p.stock,
    })),
  };
}

async function consultarStock({ producto }) {
  const resolucion = await resolverProducto(producto);
  if (resolucion.noExiste) {
    return {
      encontrado: false,
      mensaje: `No existe un producto que coincida con "${producto}".`,
      ...(await ayudaSinResultados(producto)),
    };
  }
  if (resolucion.ambiguo) {
    return {
      encontrado: false,
      ambiguo: true,
      candidatos: resolucion.ambiguo.map(resumenProducto),
      mensaje: `"${producto}" coincide con varios productos: pregunta al cliente cuál necesita.`,
    };
  }
  const encontrado = resolucion.producto;
  return {
    encontrado: true,
    producto: { ...resumenProducto(encontrado), disponible: encontrado.stock > 0 },
  };
}

// Ventana en que un pedido idéntico se considera "confirmación repetida"
// (el cliente dice "sí, confirmo" cuando el pedido YA se creó en el turno
// anterior — sin esta guarda se duplicaría el pedido y el descuento de stock).
const VENTANA_DUPLICADO_MS = 10 * 60 * 1000;

function esPedidoIdentico(pedidoPrevio, lineas) {
  const items = pedidoPrevio.items ?? [];
  if (items.length !== lineas.length) return false;
  const clave = (id, cantidad) => `${id}:${Number(cantidad)}`;
  const previas = new Set(items.map((i) => clave(i.producto_id, i.cantidad)));
  return lineas.every((l) => previas.has(clave(l.producto.id, l.cantidad)));
}

async function crearPedido({ nombre_cliente, items, direccion, notas, confirmar_duplicado }, telefono) {
  if (!Array.isArray(items) || !items.length) return { creado: false, motivo: 'El pedido no tiene productos.' };

  // Validar cada ítem contra el catálogo ANTES de escribir nada
  const porProducto = new Map(); // id → { producto, cantidad } (agrega duplicados)
  const problemas = [];
  for (const item of items) {
    const cantidad = Number(item.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      problemas.push(`Cantidad inválida para "${item.producto}".`);
      continue;
    }
    const resolucion = await resolverProducto(item.producto);
    if (resolucion.noExiste) { problemas.push(`No existe el producto "${item.producto}".`); continue; }
    if (resolucion.ambiguo) {
      problemas.push(`"${item.producto}" es ambiguo, coincide con: ${resolucion.ambiguo.map((p) => p.nombre).join(', ')}. Pregunta al cliente cuál.`);
      continue;
    }
    const producto = resolucion.producto;
    if (producto.unidad !== 'kg' && !Number.isInteger(cantidad)) {
      problemas.push(`${producto.nombre} se vende por unidad entera (${producto.unidad}): la cantidad ${cantidad} no es válida.`);
      continue;
    }
    const linea = porProducto.get(producto.id) ?? { producto, cantidad: 0 };
    linea.cantidad += cantidad;
    porProducto.set(producto.id, linea);
  }

  // El stock se valida sobre la cantidad TOTAL por producto (el mismo producto
  // puede venir repetido en varias líneas del pedido).
  const lineas = [...porProducto.values()];
  for (const linea of lineas) {
    if (linea.producto.stock < linea.cantidad) {
      problemas.push(`Stock insuficiente de ${linea.producto.nombre}: pediste ${linea.cantidad} y quedan ${linea.producto.stock} ${linea.producto.unidad}.`);
    }
  }
  if (problemas.length) return { creado: false, problemas };

  if (!confirmar_duplicado) {
    const ultimo = await db.pedidos.ultimoPorTelefono(telefono);
    const esReciente = ultimo && (Date.now() - new Date(ultimo.created_at).getTime()) < VENTANA_DUPLICADO_MS;
    if (ultimo && ultimo.estado === 'recibido' && esReciente && esPedidoIdentico(ultimo, lineas)) {
      return {
        creado: false,
        duplicado: true,
        pedido_existente: { id: ultimo.id, total: ultimo.total },
        motivo: `Ya existe el pedido #${ultimo.id} idéntico y recién creado — probablemente el cliente solo está confirmando de nuevo. Dile que su pedido ya quedó registrado. Solo si de verdad quiere pedir LO MISMO otra vez, vuelve a llamar con confirmar_duplicado=true.`,
      };
    }
  }

  const total = Math.round(lineas.reduce((suma, l) => suma + l.producto.precio * l.cantidad, 0));
  const pedido = await db.pedidos.crear(
    {
      telefono_cliente: telefono,
      nombre_cliente,
      direccion: direccion ?? null,
      notas: notas ?? null,
      total,
    },
    lineas.map((l) => ({
      producto_id: l.producto.id,
      nombre_producto: l.producto.nombre,
      cantidad: l.cantidad,
      precio_unitario: l.producto.precio,
    }))
  );

  // Descontar stock (después de crear el pedido)
  for (const linea of lineas) {
    await db.productos.descontarStock(linea.producto.id, linea.cantidad);
  }

  return {
    creado: true,
    pedido: {
      id: pedido.id,
      total,
      items: lineas.map((l) => ({ producto: l.producto.nombre, cantidad: l.cantidad, subtotal: Math.round(l.producto.precio * l.cantidad) })),
    },
  };
}

async function cancelarPedido(telefono) {
  const pedido = await db.pedidos.ultimoPorTelefono(telefono);
  if (!pedido) return { cancelado: false, motivo: 'El cliente no tiene pedidos registrados.' };
  if (pedido.estado === 'cancelado') {
    return { cancelado: false, motivo: `El pedido #${pedido.id} ya estaba cancelado.` };
  }
  if (pedido.estado !== 'recibido') {
    return { cancelado: false, motivo: `El pedido #${pedido.id} ya está en estado "${pedido.estado}": a esta altura los cambios los coordina la tienda directamente.` };
  }
  await db.pedidos.actualizarEstado(pedido.id, 'cancelado');
  for (const item of pedido.items ?? []) {
    if (item.producto_id) await db.productos.reponerStock(item.producto_id, item.cantidad);
  }
  return {
    cancelado: true,
    pedido_id: pedido.id,
    mensaje: 'Pedido cancelado y stock repuesto. Si el cliente quería CAMBIAR su pedido, crea ahora el nuevo con crear_pedido.',
  };
}

async function consultarPedido(telefono) {
  const pedido = await db.pedidos.ultimoPorTelefono(telefono);
  if (!pedido) return { encontrado: false, mensaje: 'El cliente no tiene pedidos registrados.' };
  return {
    encontrado: true,
    pedido: {
      id: pedido.id,
      estado: pedido.estado,
      total: pedido.total,
      creado: pedido.created_at,
      items: (pedido.items || []).map((i) => ({ producto: i.nombre_producto, cantidad: i.cantidad })),
    },
  };
}

module.exports = { TOOL_DEFINITIONS, ejecutarHerramienta };
