(function () {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = `
    <style>
.breadcrumb-container { margin: 5px; font: 12px sans-serif; }
#chart { width: 100%; height: 80%; overflow: hidden; }
.sunburst-arc { stroke: #fff; transition: fill-opacity 0.3s ease-out; }
.sunburst-arc:hover { fill-opacity: 0.7; cursor: pointer; }
svg { background-color: transparent; }
    </style>
    <div class="breadcrumb-container" id="breadcrumb"></div>
    <div id="chart"></div>
    `;

    const parseMetadata = metadata => {
        const { dimensions: dimensionsMap, mainStructureMembers: measuresMap } = metadata;
        const dimensions = Object.values(dimensionsMap || {}).map(d => ({ id: d.id, key: d.key }));
        const measures = Object.values(measuresMap || {}).map(m => ({ id: m.id, key: m.key }));
        return { dimensions, measures };
    };

    class SunburstNiceWidget extends HTMLElement {
        constructor() {
            super();
            this._shadowRoot = this.attachShadow({ mode: 'open' });
            this._shadowRoot.appendChild(tmpl.content.cloneNode(true));
            this._props = {};
            this.resizeObserver = new ResizeObserver(() => this._onResize());
            this.resizeObserver.observe(this);

            const script = document.createElement('script');
            script.src = 'https://d3js.org/d3.v6.min.js';
            script.onload = () => {
                this._ready = true;
                // render a fallback if no SAC data yet
                if (!this.currentHierarchy) {
                    this._render(this._getSampleHierarchy());
                }
            };
            this._shadowRoot.appendChild(script);
        }

        disconnectedCallback() { this.resizeObserver.disconnect(); }
        onCustomWidgetBeforeUpdate(changedProperties) { this._props = { ...this._props, ...changedProperties }; }
        onCustomWidgetAfterUpdate(changedProperties) {
            if ("myDataBinding" in changedProperties) {
                this._updateData(changedProperties.myDataBinding);
            }
        }

        _onResize() { this._render(this.currentHierarchy || this._getSampleHierarchy()); }

        _updateData(dataBinding) {
            if (!this._ready) return;
            if (!dataBinding || dataBinding.state === 'loading') return;
            if (!dataBinding.data || !Array.isArray(dataBinding.data) || dataBinding.data.length === 0) {
                this.currentHierarchy = null;
                this._render(this._getSampleHierarchy());
                return;
            }
            const { data, metadata } = dataBinding;
            this._props.metadata = metadata;
            const hierarchy = this._transformToHierarchy(data);
            this.currentHierarchy = hierarchy;
            this._render(hierarchy);
        }

        _transformToHierarchy(rows) {
            // Expect SAC rows with dimensions_0 (label, id, parentId) and measures_0.raw
            const root = { name: "root", children: [] };
            const idToNode = new Map();
            idToNode.set(null, root);
            for (const item of rows) {
                if (!item.dimensions_0) continue;
                const node = { name: item.dimensions_0.label, value: item.measures_0 ? item.measures_0.raw : 0, children: [], raw: item };
                idToNode.set(item.dimensions_0.id, node);
                const parent = idToNode.get(item.dimensions_0.parentId) || root;
                parent.children.push(node);
            }
            return root;
        }

        _buildObservableHierarchy(csv) {
            const root = { name: "root", children: [] };
            for (let i = 0; i < csv.length; i++) {
                const sequence = csv[i][0];
                const size = +csv[i][1];
                if (isNaN(size)) continue;
                const parts = sequence.split("-");
                let currentNode = root;
                for (let j = 0; j < parts.length; j++) {
                    const nodeName = parts[j];
                    if (j + 1 < parts.length) {
                        let childNode = currentNode.children.find(c => c.name === nodeName);
                        if (!childNode) { childNode = { name: nodeName, children: [] }; currentNode.children.push(childNode); }
                        currentNode = childNode;
                    } else {
                        currentNode.children.push({ name: nodeName, value: size });
                    }
                }
            }
            return root;
        }

        _getSampleHierarchy() {
            // Small sample sequences similar to Observable demo
            const csv = [
                ["home-search-product-end", 5],
                ["home-search-end", 3],
                ["home-account-end", 2],
                ["product-end", 4],
                ["search-product-end", 3],
                ["other-end", 2]
            ];
            return this._buildObservableHierarchy(csv);
        }

        _render(data) {
            if (!data || !window.d3) return;
            const d3 = window.d3;
            const width = this._props.width || this.offsetWidth || 640;
            const height = this._props.height || this.offsetHeight || 640;
            const radius = Math.min(width, height) / 2;

            const chartHost = this._shadowRoot.getElementById('chart');
            const breadcrumbHost = this._shadowRoot.getElementById('breadcrumb');
            d3.select(chartHost).selectAll('*').remove();
            d3.select(breadcrumbHost).selectAll('*').remove();

            const root = this._partition(data, radius, d3);

            // Color: stable one-color-per-dimension using raw id when available
            const color = (key) => this._colorForName(String(key));

            const arc = d3.arc()
                .startAngle(d => d.x0)
                .endAngle(d => d.x1)
                .padAngle(1 / radius)
                .padRadius(radius)
                .innerRadius(d => Math.sqrt(d.y0))
                .outerRadius(d => Math.sqrt(d.y1) - 1);

            const mousearc = d3.arc()
                .startAngle(d => d.x0)
                .endAngle(d => d.x1)
                .innerRadius(d => Math.sqrt(d.y0))
                .outerRadius(radius);

            const svg = d3.select(chartHost).append('svg')
                .attr('viewBox', `${-radius} ${-radius} ${radius * 2} ${radius * 2}`)
                .style('max-width', `${width}px`)
                .style('font', '12px sans-serif');

            const element = svg.node();
            element.value = { sequence: [], percentage: 0.0 };

            const pathData = root.descendants().filter(d => d.depth && d.x1 - d.x0 > 0.001);

            const path = svg.append('g')
                .selectAll('path')
                .data(pathData)
                .join('path')
                .attr('class', 'sunburst-arc')
                .attr('fill', d => color(this._colorKeyForNode(d)))
                .attr('d', arc)
                .on('click', (event, d) => this._handleSegmentClick(d));

            svg.append('g')
                .attr('fill', 'none')
                .attr('pointer-events', 'all')
                .selectAll('path')
                .data(pathData)
                .join('path')
                .attr('d', mousearc)
                .on('mouseleave', () => {
                    path.attr('fill-opacity', 1);
                    element.value = { sequence: [], percentage: 0.0 };
                    element.dispatchEvent(new CustomEvent('input'));
                    this._renderBreadcrumb(breadcrumbHost, element.value, color, d3);
                })
                .on('mouseenter', (event, d) => {
                    const sequence = d.ancestors().reverse().slice(1);
                    path.attr('fill-opacity', node => sequence.indexOf(node) >= 0 ? 1.0 : 0.3);
                    const percentage = root.value ? ((100 * d.value) / root.value).toPrecision(3) : 0;
                    element.value = { sequence, percentage };
                    element.dispatchEvent(new CustomEvent('input'));
                    this._renderBreadcrumb(breadcrumbHost, element.value, color, d3);
                });

            this._renderBreadcrumb(breadcrumbHost, element.value, color, d3);
        }

        _renderBreadcrumb(host, sunburst, color, d3) {
            const breadcrumbHeight = 30;
            // Clear previous breadcrumb before drawing a new one
            d3.select(host).selectAll('*').remove();

            // Compute dynamic widths per label using canvas text metrics
            const ctx = this._measureCtx || (this._measureCtx = document.createElement('canvas').getContext('2d'));
            ctx.font = '12px sans-serif';
            const labels = sunburst.sequence.map(d => d.data.name);
            const widths = labels.map(t => Math.ceil(ctx.measureText(t).width) + 28); // padding for arrow + text
            const positions = [];
            let acc = 0;
            for (let i = 0; i < widths.length; i++) { positions.push(acc); acc += widths[i]; }
            const totalWidth = Math.max(acc + 60, 200);

            const tipWidth = 12;
            const polygonFor = (w, i) => {
                const points = [
                    `0,0`, `${w},0`, `${w + tipWidth},${breadcrumbHeight / 2}`,
                    `${w},${breadcrumbHeight}`, `0,${breadcrumbHeight}`
                ];
                if (i > 0) points.push(`${tipWidth},${breadcrumbHeight / 2}`);
                return points.join(' ');
            };

            const svg = d3.select(host).append('svg')
                .attr('viewBox', `0 0 ${totalWidth} ${breadcrumbHeight}`)
                .style('font', '12px sans-serif')
                .style('margin', '5px');

            const g = svg.selectAll('g')
                .data(sunburst.sequence)
                .join('g')
                .attr('transform', (d, i) => `translate(${positions[i]}, 0)`);

            g.append('polygon')
                .attr('points', (d, i) => polygonFor(widths[i], i))
                .attr('fill', d => color(this._colorKeyForNode(d)))
                .attr('stroke', 'white');

            g.append('text')
                .attr('x', (d, i) => (widths[i] + 10) / 2)
                .attr('y', 15)
                .attr('dy', '0.35em')
                .attr('text-anchor', 'middle')
                .attr('fill', 'white')
                .text(d => d.data.name);

            svg.append('text')
                .text(sunburst.percentage > 0 ? sunburst.percentage + '%' : '')
                .attr('x', acc + 30)
                .attr('y', breadcrumbHeight / 2)
                .attr('dy', '0.35em')
                .attr('text-anchor', 'start');
        }

        _colorForName(name) {
            if (!this._colorCache) this._colorCache = new Map();
            if (this._colorCache.has(name)) return this._colorCache.get(name);
            let hash = 0;
            for (let i = 0; i < name.length; i++) {
                hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
            }
            const hue = hash % 360;
            const color = `hsl(${hue},65%,50%)`;
            this._colorCache.set(name, color);
            return color;
        }

        _colorKeyForNode(d) {
            const raw = d && d.data && d.data.raw;
            if (raw && raw.dimensions_0 && raw.dimensions_0.id) return raw.dimensions_0.id;
            return d && d.data && d.data.name ? d.data.name : 'unknown';
        }

        _getTopParentName(node) {
            let current = node;
            while (current.parent && current.parent.depth > 0) {
                current = current.parent;
            }
            return current.data.name;
        }

        _partition(data, radius, d3) {
            return d3.partition().size([2 * Math.PI, radius * radius])(
                d3.hierarchy(data)
                    .sum(d => d.value)
                    .sort((a, b) => b.value - a.value)
            );
        }

        _handleSegmentClick(d) {
            if (!this._props || !this._props.metadata || !this._props['dataBindings']) return;
            const { dimensions } = parseMetadata(this._props.metadata);
            const [dimension] = dimensions;
            const linkedAnalysis = this._props['dataBindings'].getDataBinding('myDataBinding').getLinkedAnalysis();
            if (d.selected) {
                linkedAnalysis.removeFilters();
                d.selected = false;
            } else {
                const selection = {};
                const key = dimension.key;
                const dimensionId = dimension.id;
                const raw = d.data && d.data.raw;
                if (raw && raw.dimensions_0 && raw.dimensions_0.id) {
                    selection[dimensionId] = raw.dimensions_0.id;
                }
                linkedAnalysis.setFilters(selection);
                d.selected = true;
            }
        }
    }

    customElements.define('sunburst-nice-widget', SunburstNiceWidget);
})();
