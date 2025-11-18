# -*- coding: utf-8 -*-
{
    'name': "CRM Product Configurator",
    'version': '18.0.1.0.0',
    'summary': "Dynamic product configuration in CRM opportunities",
    'description': """
This module provides product configuration functionality in the CRM pipeline.
Users can select product variants, manage optional products, and view real-time product data within the CRM form.
    """,
    'author': "Entrivis Tech",
    'website': "https://www.entrivistech.com",
    'category': 'CRM',
    'license': 'LGPL-3',
    'depends': ['base', 'web','crm_customisation','product_matrix'],
    'data': [
        'security/ir.model.access.csv',
        # 'views/crm_lead_view.xml',
        'views/optional_product_template.xml',
        'views/product_template_views.xml',
    ],
    'images': ['/static/description/icon.png'],
    'assets': {
        'web.assets_backend': [
            'crm_product_configurator/static/src/js/crm_product_field.js',
            'crm_product_configurator/static/src/xml/crm_product_template.xml',
            'crm_product_configurator/static/src/js/product_configurator_dialog/product_configurator_dialog.js',
            'crm_product_configurator/static/src/js/product_configurator_dialog/product_configurator_dialog.xml',
            'crm_product_configurator/static/src/js/product_list/product_list.js',
            'crm_product_configurator/static/src/js/product_list/product_list.xml',
            'crm_product_configurator/static/src/js/product/product.js',
            'crm_product_configurator/static/src/js/product/product_template.xml',
            'crm_product_configurator/static/src/js/product_template_attribute_line/product_template_attribute_line.js',
            'crm_product_configurator/static/src/js/product_template_attribute_line/product_template_attribute_line.xml',
            'crm_product_configurator/static/src/js/product/product.scss',
            'crm_product_configurator/static/src/js/product_template_attribute_line/product_template_attribute_line.scss'
        ],
    },
    'installable': True,
    'auto_install': False,
    'application': False,
}
