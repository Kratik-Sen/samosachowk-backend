const express = require('express');
const router = express.Router();
const multer = require('multer');
const Product = require('../models/Product');
const { protect, authorize } = require('../middleware/auth');
const { uploadToCloudinary } = require('../config/cloudinary');
const { emitResourceChanged } = require('../realtime');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Only image uploads are allowed'));
      return;
    }

    cb(null, true);
  },
});

const parsePackages = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall through to comma separated parsing.
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const buildProductPayload = (body) => ({
  name: body.name,
  category: body.category,
  price: Number(body.price),
  description: body.description,
  packages: parsePackages(body.packages),
  image: body.image,
  stock: Number(body.stock || 0),
  status: body.status || 'Active',
});

const buildProductFilter = (query) => {
  const filter = {};

  if (query.status) {
    filter.status = query.status;
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.search) {
    filter.$or = [
      { name: { $regex: query.search, $options: 'i' } },
      { category: { $regex: query.search, $options: 'i' } },
      { description: { $regex: query.search, $options: 'i' } },
    ];
  }

  return filter;
};

// @route   GET /api/products
// @desc    Product catalog for vendor ordering and admin management
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const filter = buildProductFilter(req.query);

    if (!req.query.status && req.user.role !== 'admin') {
      filter.status = 'Active';
    }

    const products = await Product.find(filter).sort('category name');
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/products/categories
// @desc    Product categories
// @access  Private
router.get('/categories', protect, async (req, res) => {
  try {
    const categories = await Product.distinct('category', { status: 'Active' });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products
// @desc    Create product
// @access  Private (Admin)
router.post('/', protect, authorize('admin'), upload.single('image'), async (req, res) => {
  try {
    const payload = buildProductPayload(req.body);

    if (req.file) {
      payload.image = await uploadToCloudinary(req.file);
    }

    const product = await Product.create(payload);
    res.status(201).json(product);
    emitResourceChanged(req, {
      domains: ['products', 'admin', 'vendors'],
      action: 'created',
      entity: 'product',
      entityId: product._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/products/:id
// @desc    Update product
// @access  Private (Admin)
router.put('/:id', protect, authorize('admin'), upload.single('image'), async (req, res) => {
  try {
    const payload = buildProductPayload(req.body);

    if (req.file) {
      payload.image = await uploadToCloudinary(req.file);
    }

    Object.keys(payload).forEach((key) => {
      if (payload[key] === undefined || payload[key] === '' || Number.isNaN(payload[key])) {
        delete payload[key];
      }
    });

    const product = await Product.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
    emitResourceChanged(req, {
      domains: ['products', 'admin', 'vendors'],
      action: 'updated',
      entity: 'product',
      entityId: product._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/products/:id
// @desc    Delete product
// @access  Private (Admin)
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { status: 'Inactive' },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Product removed' });
    emitResourceChanged(req, {
      domains: ['products', 'admin', 'vendors'],
      action: 'deleted',
      entity: 'product',
      entityId: product._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
